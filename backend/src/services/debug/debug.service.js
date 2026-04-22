// src/services/debug/debug.service.js
// Error detection + RAG-powered fix generation

import { query } from '../../config/database.js';
import { ragQuery } from '../rag/rag.service.js';
import { createFixPR } from '../github/pr.service.js';
import { embedAndStore } from '../rag/embedder.service.js';
import { smartChunk } from '../rag/chunker.service.js';
import { getAnthropic, CLAUDE_MODEL } from '../../config/anthropic.js';
import logger from '../../utils/logger.js';

// ── Error Detection ───────────────────────────────────────────────────────────
/**
 * Parse raw log text into structured error entries
 */
export async function parseAndStoreErrors(rawLog, workspaceId, repoId = null) {
  const errors = extractErrors(rawLog);

  const stored = [];
  for (const error of errors) {
    const { rows } = await query(
      `INSERT INTO log_entries
       (workspace_id, repo_id, raw_log, level, error_type, error_message, stack_trace, file_path, line_number, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        workspaceId, repoId, rawLog,
        error.level, error.errorType, error.message,
        error.stackTrace, error.filePath, error.lineNumber,
        JSON.stringify(error.metadata),
      ],
    );
    stored.push({ id: rows[0].id, ...error });
  }

  // Embed log for future RAG retrieval
  const chunks = await smartChunk(rawLog, 'logs', {
    source: 'logs',
    workspaceId,
    documentId: `log_${Date.now()}`,
    timestamp: new Date().toISOString(),
  });

  // Get workspace namespace
  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (ws?.pinecone_namespace) {
    await embedAndStore(chunks, ws.pinecone_namespace);
  }

  return stored;
}

/**
 * Extract structured errors from raw log text
 */
function extractErrors(rawLog) {
  const errors = [];
  const lines = rawLog.split('\n');

  // Common error patterns
  const patterns = [
    // Node.js style: Error: message at file:line
    {
      regex: /^(?:\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}.*?)?\s*(?:ERROR|FATAL|Error|Uncaught)[\s:]+(.+)/,
      level: 'ERROR',
    },
    // Python style: raise SomeError
    {
      regex: /(?:raise\s+)?([A-Z][a-zA-Z]+Error|[A-Z][a-zA-Z]+Exception):\s*(.+)/,
      level: 'ERROR',
    },
    // Generic WARN
    {
      regex: /(?:WARN|WARNING)[\s:]+(.+)/,
      level: 'WARN',
    },
  ];

  let currentError = null;
  const stackLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Try to match an error line
    let matched = false;
    for (const { regex, level } of patterns) {
      const m = line.match(regex);
      if (m) {
        // Save previous error
        if (currentError) {
          currentError.stackTrace = stackLines.join('\n');
          errors.push(currentError);
          stackLines.length = 0;
        }

        // Extract file location if present
        const locationMatch = rawLog.slice(rawLog.indexOf(m[0])).match(/at (.+?)\s+\((.+?):(\d+)/);

        currentError = {
          level,
          message: m[1] || m[0],
          errorType: extractErrorType(m[0]),
          stackTrace: '',
          filePath: locationMatch?.[2] || null,
          lineNumber: locationMatch?.[3] ? parseInt(locationMatch[3]) : null,
          metadata: { originalLine: i + 1 },
        };
        matched = true;
        break;
      }
    }

    // Collect stack trace lines
    if (!matched && currentError && (line.startsWith('    at ') || line.startsWith('\tat '))) {
      stackLines.push(line);
    }
  }

  if (currentError) {
    currentError.stackTrace = stackLines.join('\n');
    errors.push(currentError);
  }

  return errors;
}

function extractErrorType(errorLine) {
  const typeMatch = errorLine.match(/([A-Z][a-zA-Z]+Error|[A-Z][a-zA-Z]+Exception)/);
  return typeMatch?.[1] || 'UnknownError';
}


// ── Fix Generation ────────────────────────────────────────────────────────────
/**
 * Generate a fix for an error using RAG + Claude
 */
export async function generateFix({ logEntryId, workspaceId, namespace, userId }) {
  const { rows: [logEntry] } = await query(
    `SELECT * FROM log_entries WHERE id = $1`,
    [logEntryId],
  );
  if (!logEntry) throw new Error('Log entry not found');

  // Update status to 'fixing'
  await query(`UPDATE log_entries SET status = 'fixing' WHERE id = $1`, [logEntryId]);

  // Build a targeted query for RAG
  const ragQuestion = `
    I have this error: "${logEntry.error_message}"
    Error type: ${logEntry.error_type}
    Stack trace: ${logEntry.stack_trace?.slice(0, 500) || 'N/A'}
    File: ${logEntry.file_path || 'unknown'}
    
    What is the root cause and how should I fix it?
    Show the corrected code if possible.
  `;

  // Use RAG to find similar issues + relevant code context
  const ragResult = await ragQuery({
    question: ragQuestion,
    workspaceId,
    namespace,
    userId,
    filters: { source: 'code' }, // Search code base primarily
  });

  // Now generate the actual fix
  const anthropic = getAnthropic();
  const fixResponse = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 2000,
    system: `You are a senior software engineer. Generate a precise, minimal fix for the given error.
Return JSON ONLY with this exact structure:
{
  "explanation": "what caused the error and how the fix resolves it",
  "filesChanged": [
    {
      "path": "relative/file/path",
      "after": "complete corrected file content"
    }
  ],
  "confidence": "high|medium|low"
}`,
    messages: [{
      role: 'user',
      content: `Error: ${logEntry.error_message}
Type: ${logEntry.error_type}
Stack: ${logEntry.stack_trace?.slice(0, 800)}

Context from knowledge base:
${ragResult.answer}

Generate the fix JSON.`,
    }],
  });

  let fixData;
  try {
    const jsonText = fixResponse.content[0].text.replace(/```json|```/g, '').trim();
    fixData = JSON.parse(jsonText);
  } catch {
    fixData = {
      explanation: fixResponse.content[0].text,
      filesChanged: [],
      confidence: 'low',
    };
  }

  // Store fix suggestion
  const { rows: [fix] } = await query(
    `INSERT INTO fix_suggestions
     (log_entry_id, workspace_id, suggested_fix, explanation, files_changed, sources_used)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id`,
    [
      logEntryId, workspaceId,
      fixData.filesChanged?.map(f => f.after).join('\n---\n') || '',
      fixData.explanation,
      JSON.stringify(fixData.filesChanged || []),
      JSON.stringify(ragResult.sources),
    ],
  );

  await query(`UPDATE log_entries SET status = 'fixed' WHERE id = $1`, [logEntryId]);

  return { fixId: fix.id, ...fixData, sources: ragResult.sources };
}

/**
 * Create a PR from an existing fix suggestion
 */
export async function createPRFromFix({ fixId, workspaceId, userId }) {
  const { rows: [fix] } = await query(
    `SELECT fs.*, le.error_message, le.error_type, le.repo_id
     FROM fix_suggestions fs
     JOIN log_entries le ON le.id = fs.log_entry_id
     WHERE fs.id = $1`,
    [fixId],
  );

  if (!fix.repo_id) throw new Error('No repo associated with this error');

  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1`,
    [fix.repo_id],
  );
  const { rows: [user] } = await query(
    `SELECT github_token FROM users WHERE id = $1`,
    [userId],
  );

  const [owner, repoName] = repo.repo_full_name.split('/');

  const { prUrl, prNumber } = await createFixPR({
    githubToken: user.github_token,
    owner,
    repo: repoName,
    errorDescription: `${fix.error_type}: ${fix.error_message?.slice(0, 100)}`,
    fixExplanation: fix.explanation,
    filesChanged: fix.files_changed,
    sourcesUsed: fix.sources_used,
  });

  await query(
    `UPDATE fix_suggestions SET pr_url = $1, pr_number = $2, status = 'pr_created' WHERE id = $3`,
    [prUrl, prNumber, fixId],
  );
  await query(
    `UPDATE log_entries SET status = 'pr_created' WHERE id = $1`,
    [fix.log_entry_id],
  );

  return { prUrl, prNumber };
}
// src/services/debug/fix-generator.service.js
// RAG-powered fix generation using Claude

import { getAnthropic, CLAUDE_MODEL } from '../../config/anthropic.js';
import { ragQuery } from '../rag/rag.service.js';
import logger from '../../utils/logger.js';

/**
 * Generate a structured code fix for a detected error
 * @param {object} params
 * @param {object} params.errorEntry  - The log_entry row
 * @param {string} params.workspaceId
 * @param {string} params.namespace   - Pinecone namespace
 * @param {string} params.userId
 * @returns {{ explanation, filesChanged, confidence, sources }}
 */
export async function generateFixForError({ errorEntry, workspaceId, namespace, userId }) {
  const { error_type, error_message, stack_trace, file_path, line_number } = errorEntry;

  logger.info(`[fix-generator] Generating fix for ${error_type}: ${error_message?.slice(0, 60)}`);

  // ── Step 1: RAG search for similar past issues + related code ─────────────
  const ragQuestion = buildRagQuestion({ error_type, error_message, stack_trace, file_path, line_number });

  const ragResult = await ragQuery({
    question: ragQuestion,
    workspaceId,
    namespace,
    userId,
    filters: {}, // Search all sources — code, past logs, docs
  });

  // ── Step 2: Generate fix using Claude ─────────────────────────────────────
  const anthropic = getAnthropic();

  const systemPrompt = `You are a senior software engineer specializing in debugging and code fixes.
Your task is to analyze an error and generate a precise, minimal fix.

RULES:
- Only fix what is necessary — do not refactor unrelated code
- Provide complete corrected file content for any file you modify
- Explain the root cause clearly
- Rate your confidence: high / medium / low

Respond ONLY with valid JSON matching this exact schema (no markdown, no preamble):
{
  "rootCause": "brief explanation of what caused the error",
  "explanation": "detailed explanation of the fix and why it works",
  "filesChanged": [
    {
      "path": "relative/path/to/file.js",
      "description": "what changed in this file",
      "after": "complete corrected file content here"
    }
  ],
  "confidence": "high|medium|low",
  "preventionTip": "how to avoid this error in the future"
}`;

  const userPrompt = buildUserPrompt({
    error_type,
    error_message,
    stack_trace,
    file_path,
    line_number,
    ragContext: ragResult.answer,
    sources: ragResult.sources,
  });

  let fixData;
  try {
    const response = await anthropic.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 3000,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
    });

    const rawText = response.content[0].text.trim();
    // Strip any accidental markdown fences
    const jsonText = rawText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '').trim();
    fixData = JSON.parse(jsonText);
  } catch (err) {
    logger.error('[fix-generator] JSON parse failed, using fallback:', err.message);
    fixData = {
      rootCause: 'Could not determine root cause automatically.',
      explanation: `Unable to generate structured fix. RAG context: ${ragResult.answer.slice(0, 500)}`,
      filesChanged: [],
      confidence: 'low',
      preventionTip: 'Review the stack trace manually.',
    };
  }

  return {
    ...fixData,
    sources: ragResult.sources,
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function buildRagQuestion({ error_type, error_message, stack_trace, file_path, line_number }) {
  const parts = [
    `I have a ${error_type} error: "${error_message}"`,
  ];
  if (file_path) parts.push(`In file: ${file_path}${line_number ? ` at line ${line_number}` : ''}`);
  if (stack_trace?.trim()) parts.push(`Stack trace:\n${stack_trace.slice(0, 600)}`);
  parts.push('What is the root cause and how do I fix it? Show any relevant code patterns.');
  return parts.join('\n');
}

function buildUserPrompt({ error_type, error_message, stack_trace, file_path, line_number, ragContext, sources }) {
  const sourceSummary = sources?.length
    ? `\n\nRELEVANT CONTEXT FROM KNOWLEDGE BASE:\n${sources.map((s, i) =>
        `[${i + 1}] ${s.source}${s.fileName ? ` (${s.fileName})` : ''}: ${s.excerpt}`
      ).join('\n')}`
    : '';

  return `ERROR DETAILS:
Type: ${error_type}
Message: ${error_message}
${file_path ? `File: ${file_path}${line_number ? `:${line_number}` : ''}` : ''}
${stack_trace?.trim() ? `\nStack Trace:\n${stack_trace.slice(0, 1000)}` : ''}

RAG ANALYSIS:
${ragContext}
${sourceSummary}

Generate the JSON fix response now.`;
}
// src/services/ingestion/log.ingest.js
// Parses raw logs into structured errors, stores them, and queues embedding

import { parseErrors } from '../debug/error-parser.service.js';
import { ErrorLogModel } from '../../models/error-log.model.js';
import { smartChunk } from '../rag/chunker.service.js';
import { embedAndStore } from '../rag/embedder.service.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

/**
 * Main entry point — ingest a raw log string
 * @param {object} params
 * @param {string} params.rawLog
 * @param {string} params.workspaceId
 * @param {string|null} params.repoId
 * @returns {Array} stored error entries
 */
export async function ingestLog({ rawLog, workspaceId, repoId = null }) {
  if (!rawLog?.trim()) return [];

  // ── Step 1: Parse into structured errors ──────────────────────────────────
  const parsedErrors = parseErrors(rawLog);
  logger.info(`[log-ingest] Parsed ${parsedErrors.length} error(s) from ${rawLog.length} chars`);

  // ── Step 2: Store each error ───────────────────────────────────────────────
  const stored = [];
  for (const err of parsedErrors) {
    try {
      const entry = await ErrorLogModel.create({
        workspaceId,
        repoId,
        rawLog,
        level:        err.level,
        errorType:    err.errorType,
        errorMessage: err.message,
        stackTrace:   err.stackTrace || null,
        filePath:     err.filePath || null,
        lineNumber:   err.lineNumber || null,
        metadata:     err.metadata || {},
      });
      stored.push({ id: entry.id, ...err });
    } catch (dbErr) {
      logger.error('[log-ingest] DB insert failed:', dbErr.message);
    }
  }

  // ── Step 3: Embed the full log for RAG retrieval ───────────────────────────
  // (Even if no structured errors found — the log may still be useful context)
  try {
    const { rows: [ws] } = await query(
      `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const namespace = ws?.pinecone_namespace || workspaceId;

    const chunks = await smartChunk(rawLog, 'logs', {
      source:      'logs',
      workspaceId,
      documentId:  `log_${workspaceId}_${Date.now()}`,
      repoId:      repoId || null,
      timestamp:   new Date().toISOString(),
    });

    const vectorIds = await embedAndStore(chunks, namespace);

    // Attach first vector ID to first stored error for traceability
    if (stored.length > 0 && vectorIds.length > 0) {
      await ErrorLogModel.markEmbedded(stored[0].id, vectorIds[0]);
    }

    logger.info(`[log-ingest] Embedded ${chunks.length} chunk(s) → ${vectorIds.length} vectors`);
  } catch (embedErr) {
    logger.error('[log-ingest] Embedding failed (non-fatal):', embedErr.message);
  }

  return stored;
}

/**
 * Ingest a structured error object directly (from application error handlers)
 * @param {object} params
 * @param {string} params.errorType
 * @param {string} params.message
 * @param {string} params.stackTrace
 * @param {string} params.filePath
 * @param {number} params.lineNumber
 * @param {string} params.workspaceId
 * @param {string} params.repoId
 */
export async function ingestStructuredError({
  errorType,
  message,
  stackTrace,
  filePath,
  lineNumber,
  workspaceId,
  repoId = null,
}) {
  const rawLog = [
    `${errorType}: ${message}`,
    stackTrace || '',
    filePath ? `at ${filePath}${lineNumber ? `:${lineNumber}` : ''}` : '',
  ].filter(Boolean).join('\n');

  const entry = await ErrorLogModel.create({
    workspaceId,
    repoId,
    rawLog,
    level:        'ERROR',
    errorType,
    errorMessage: message,
    stackTrace,
    filePath,
    lineNumber,
    metadata:     {},
  });

  logger.info(`[log-ingest] Structured error stored: ${entry.id}`);
  return entry;
}
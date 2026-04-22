// src/services/ingestion/ingestion.service.js
// Central orchestrator for all ingestion pipelines

import { ingestFile } from './file.ingest.js';
import { ingestLog } from './log.ingest.js';
import { processTelegramUpdate } from './telegram.ingest.js';
import { embedQueue } from '../../jobs/queue.js';
import { query } from '../../config/database.js';
import { maskSecrets } from '../../utils/secretMask.js';
import logger from '../../utils/logger.js';

/**
 * Ingest a plain text snippet (wiki page, pasted note, etc.)
 * @param {object} params
 * @param {string} params.content
 * @param {string} params.title
 * @param {string} params.source     - 'manual' | 'wiki' | 'notion' | etc.
 * @param {string} params.workspaceId
 * @param {string} params.userId
 * @returns {{ documentId }}
 */
export async function ingestText({ content, title, source = 'manual', workspaceId, userId }) {
  if (!content?.trim()) throw new Error('content is required');

  const safeContent = maskSecrets(content);
  const fileName = title || `snippet-${Date.now()}`;

  // Store as document
  const { rows: [doc] } = await query(
    `INSERT INTO documents (workspace_id, uploaded_by, file_name, file_type, file_size, content)
     VALUES ($1, $2, $3, 'text/plain', $4, $5)
     RETURNING id`,
    [workspaceId, userId, fileName, Buffer.byteLength(safeContent, 'utf8'), safeContent],
  );

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );

  await embedQueue.add('embed-message', {
    type: 'document',
    documentId: doc.id,
    content: safeContent,
    source,
    workspaceId,
    namespace: ws?.pinecone_namespace || workspaceId,
    metadata: {
      source,
      workspaceId,
      documentId: doc.id,
      fileName,
      timestamp: new Date().toISOString(),
    },
  });

  logger.info(`[ingestion] Text snippet ingested: doc ${doc.id} (${safeContent.length} chars)`);
  return { documentId: doc.id };
}

/**
 * Ingest a file buffer (delegates to file.ingest.js)
 */
export async function ingestFileBuffer({ buffer, fileName, mimeType, workspaceId, userId }) {
  return ingestFile({ buffer, fileName, mimeType, workspaceId, userId });
}

/**
 * Ingest raw log text (delegates to log.ingest.js)
 */
export async function ingestRawLog({ rawLog, workspaceId, repoId }) {
  return ingestLog({ rawLog, workspaceId, repoId });
}

/**
 * Ingest a Telegram update (delegates to telegram.ingest.js)
 */
export async function ingestTelegramUpdate(update, workspaceId) {
  return processTelegramUpdate(update, workspaceId);
}

/**
 * Ingest multiple messages at once (batch)
 * @param {Array<{ content, senderName, source, timestamp }>} messages
 * @param {string} workspaceId
 * @param {string} userId
 */
export async function ingestMessageBatch({ messages, workspaceId, userId }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw new Error('messages array is required');
  }

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const namespace = ws?.pinecone_namespace || workspaceId;

  const results = [];

  for (const msg of messages) {
    const safeContent = maskSecrets(msg.content || '');
    if (!safeContent.trim()) continue;

    const { rows: [stored] } = await query(
      `INSERT INTO messages
       (workspace_id, source, sender_name, content, content_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, 'text', $5, $6)
       RETURNING id`,
      [
        workspaceId,
        msg.source || 'manual',
        msg.senderName || 'Unknown',
        safeContent,
        JSON.stringify(msg.metadata || {}),
        msg.timestamp ? new Date(msg.timestamp) : new Date(),
      ],
    );

    await embedQueue.add('embed-message', {
      type: 'message',
      messageId: stored.id,
      content: safeContent,
      source: msg.source || 'manual',
      workspaceId,
      namespace,
      metadata: {
        source: msg.source || 'manual',
        workspaceId,
        messageId: stored.id,
        senderName: msg.senderName || 'Unknown',
        timestamp: msg.timestamp || new Date().toISOString(),
      },
    });

    results.push({ messageId: stored.id });
  }

  logger.info(`[ingestion] Batch: ${results.length}/${messages.length} messages ingested`);
  return { ingested: results.length, messageIds: results.map(r => r.messageId) };
}

/**
 * Get workspace ingestion stats
 */
export async function getIngestionStats(workspaceId) {
  const [msgRes, docRes, logRes] = await Promise.all([
    query(
      `SELECT
         COUNT(*)::int                                          AS total,
         COUNT(*) FILTER (WHERE embedded_at IS NOT NULL)::int  AS embedded,
         COUNT(*) FILTER (WHERE source = 'telegram')::int      AS telegram,
         COUNT(*) FILTER (WHERE content_type = 'voice')::int   AS voice
       FROM messages WHERE workspace_id = $1`,
      [workspaceId],
    ),
    query(
      `SELECT
         COUNT(*)::int                                          AS total,
         COALESCE(SUM(chunk_count), 0)::int                    AS total_chunks,
         COUNT(*) FILTER (WHERE embedded_at IS NOT NULL)::int  AS embedded
       FROM documents WHERE workspace_id = $1`,
      [workspaceId],
    ),
    query(
      `SELECT COUNT(*)::int AS total FROM log_entries WHERE workspace_id = $1`,
      [workspaceId],
    ),
  ]);

  return {
    messages:  msgRes.rows[0],
    documents: docRes.rows[0],
    logs:      logRes.rows[0],
  };
}
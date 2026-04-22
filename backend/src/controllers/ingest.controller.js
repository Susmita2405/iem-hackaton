// src/controllers/ingest.controller.js
import { embedQueue, logProcessQueue } from '../jobs/queue.js';
import { ingestFile } from '../services/ingestion/file.ingest.js';
import { ingestLog } from '../services/ingestion/log.ingest.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * POST /api/ingest/file
 * Upload a .txt or .json file to be parsed, stored, and embedded
 */
export async function uploadFile(req, res) {
  const { workspaceId } = req.body;
  const file = req.file;

  if (!file) return res.status(400).json({ error: 'No file uploaded' });
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const allowedTypes = ['text/plain', 'application/json', 'text/markdown', 'text/csv'];
  if (!allowedTypes.includes(file.mimetype)) {
    return res.status(400).json({ error: `Unsupported file type: ${file.mimetype}` });
  }

  try {
    const { documentId, chunkCount } = await ingestFile({
      buffer: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
      workspaceId,
      userId: req.user.id,
    });

    logger.info(`File ingested: ${file.originalname} → doc ${documentId}, ${chunkCount} chunks queued`);
    res.json({ ok: true, documentId, fileName: file.originalname, chunkCount });
  } catch (err) {
    logger.error('File ingestion failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/ingest/logs
 * Submit raw log text for error detection and embedding
 */
export async function submitLogs(req, res) {
  const { workspaceId, rawLog, repoId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!rawLog?.trim()) return res.status(400).json({ error: 'rawLog is required' });

  const job = await logProcessQueue.add('process-log', {
    rawLog,
    workspaceId,
    repoId: repoId || null,
  });

  res.json({ ok: true, jobId: job.id });
}

/**
 * POST /api/ingest/text
 * Directly ingest a raw text snippet (e.g. paste from a wiki)
 */
export async function ingestText(req, res) {
  const { workspaceId, content, title, source = 'manual' } = req.body;
  if (!workspaceId || !content?.trim()) {
    return res.status(400).json({ error: 'workspaceId and content are required' });
  }

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );

  // Store as a document
  const { rows: [doc] } = await query(
    `INSERT INTO documents (workspace_id, uploaded_by, file_name, file_type, file_size, content)
     VALUES ($1, $2, $3, 'text', $4, $5)
     RETURNING id`,
    [workspaceId, req.user.id, title || 'manual-snippet', Buffer.byteLength(content), content],
  );

  await embedQueue.add('embed-message', {
    type: 'document',
    documentId: doc.id,
    content,
    source,
    workspaceId,
    metadata: {
      source,
      workspaceId,
      documentId: doc.id,
      fileName: title || 'manual-snippet',
      timestamp: new Date().toISOString(),
    },
  });

  res.json({ ok: true, documentId: doc.id });
}

/**
 * GET /api/ingest/documents
 * List ingested documents for a workspace
 */
export async function listDocuments(req, res) {
  const { workspaceId, limit = 30 } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const { rows } = await query(
    `SELECT d.id, d.file_name, d.file_type, d.file_size, d.chunk_count,
            d.embedded_at, d.created_at, u.username AS uploaded_by_username
     FROM documents d
     LEFT JOIN users u ON u.id = d.uploaded_by
     WHERE d.workspace_id = $1
     ORDER BY d.created_at DESC
     LIMIT $2`,
    [workspaceId, limit],
  );
  res.json(rows);
}

/**
 * DELETE /api/ingest/documents/:id
 * Delete a document (does not delete Pinecone vectors — use cleanup job for that)
 */
export async function deleteDocument(req, res) {
  const { id } = req.params;
  const { workspaceId } = req.query;

  await query(
    `DELETE FROM documents WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  res.json({ ok: true });
}

/**
 * GET /api/ingest/messages
 * List ingested Telegram messages for a workspace
 */
export async function listMessages(req, res) {
  const { workspaceId, source, limit = 50, offset = 0 } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  let sql = `
    SELECT id, source, sender_name, content, content_type, created_at, embedded_at
    FROM messages
    WHERE workspace_id = $1
  `;
  const params = [workspaceId];

  if (source) { params.push(source); sql += ` AND source = $${params.length}`; }
  params.push(limit, offset);
  sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await query(sql, params);
  res.json(rows);
}
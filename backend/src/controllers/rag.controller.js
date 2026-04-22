// src/controllers/rag.controller.js
import { ragQuery, ragQueryStream } from '../services/rag/rag.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Resolve workspace namespace helper
 */
async function getNamespace(workspaceId) {
  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  return ws?.pinecone_namespace || workspaceId;
}

/**
 * POST /api/rag/query
 * Standard RAG question answering (full response, no streaming)
 */
export async function handleQuery(req, res) {
  const { question, workspaceId, filters } = req.body;

  if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
  if (!workspaceId)       return res.status(400).json({ error: 'workspaceId is required' });

  const namespace = await getNamespace(workspaceId);

  const result = await ragQuery({
    question: question.trim(),
    workspaceId,
    namespace,
    userId: req.user.id,
    filters: filters || {},
  });

  res.json(result);
}

/**
 * GET /api/rag/query/stream
 * Server-Sent Events streaming RAG response
 */
export async function handleQueryStream(req, res) {
  const { question, workspaceId, filters } = req.query;

  if (!question?.trim()) return res.status(400).json({ error: 'question is required' });
  if (!workspaceId)       return res.status(400).json({ error: 'workspaceId is required' });

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  let parsedFilters = {};
  try { parsedFilters = filters ? JSON.parse(filters) : {}; } catch {}

  const namespace = await getNamespace(workspaceId);

  try {
    await ragQueryStream({
      question: question.trim(),
      workspaceId,
      namespace,
      userId: req.user.id,
      filters: parsedFilters,
      onChunk: (chunk) => {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      },
    });
    res.write('data: [DONE]\n\n');
  } catch (err) {
    logger.error('Stream RAG error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  }

  res.end();
}

/**
 * GET /api/rag/history
 * Fetch past RAG queries for a workspace
 */
export async function getHistory(req, res) {
  const { workspaceId, limit = 20, offset = 0 } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const { rows } = await query(
    `SELECT id, question, answer, sources, tokens_used, latency_ms, created_at
     FROM rag_queries
     WHERE workspace_id = $1
     ORDER BY created_at DESC
     LIMIT $2 OFFSET $3`,
    [workspaceId, limit, offset],
  );
  res.json(rows);
}

/**
 * GET /api/rag/history/:id
 * Fetch a single past query with full details
 */
export async function getHistoryItem(req, res) {
  const { id } = req.params;
  const { rows: [item] } = await query(
    `SELECT * FROM rag_queries WHERE id = $1 AND user_id = $2`,
    [id, req.user.id],
  );
  if (!item) return res.status(404).json({ error: 'Query not found' });
  res.json(item);
}

/**
 * GET /api/rag/stats
 * Usage stats for a workspace
 */
export async function getStats(req, res) {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const { rows: [stats] } = await query(
    `SELECT
       COUNT(*)::int                        AS total_queries,
       COALESCE(SUM(tokens_used), 0)::int   AS total_tokens,
       COALESCE(AVG(latency_ms), 0)::int    AS avg_latency_ms,
       COALESCE(AVG(tokens_used), 0)::int   AS avg_tokens
     FROM rag_queries
     WHERE workspace_id = $1`,
    [workspaceId],
  );

  const { rows: [docCount] } = await query(
    `SELECT COUNT(*)::int AS count FROM documents WHERE workspace_id = $1`,
    [workspaceId],
  );

  const { rows: [msgCount] } = await query(
    `SELECT COUNT(*)::int AS count FROM messages WHERE workspace_id = $1`,
    [workspaceId],
  );

  res.json({
    ...stats,
    documentCount: docCount.count,
    messageCount: msgCount.count,
  });
}
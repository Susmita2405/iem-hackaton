// src/controllers/debug.controller.js
import { parseAndStoreErrors, generateFix, createPRFromFix } from '../services/debug/debug.service.js';
import { logProcessQueue, fixGenerateQueue } from '../jobs/queue.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * GET /api/debug/errors
 * List detected errors for a workspace with optional status filter
 */
export async function listErrors(req, res) {
  const { workspaceId, status, repoId, limit = 50, offset = 0 } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  let sql = `
    SELECT le.*, r.repo_full_name
    FROM log_entries le
    LEFT JOIN repositories r ON r.id = le.repo_id
    WHERE le.workspace_id = $1
  `;
  const params = [workspaceId];

  if (status) { params.push(status); sql += ` AND le.status = $${params.length}`; }
  if (repoId) { params.push(repoId); sql += ` AND le.repo_id = $${params.length}`; }

  params.push(limit, offset);
  sql += ` ORDER BY le.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

  const { rows } = await query(sql, params);
  res.json(rows);
}

/**
 * GET /api/debug/errors/:id
 * Get a single error with its fix suggestions
 */
export async function getError(req, res) {
  const { id } = req.params;
  const { rows: [error] } = await query(
    `SELECT le.*, r.repo_full_name FROM log_entries le
     LEFT JOIN repositories r ON r.id = le.repo_id
     WHERE le.id = $1`,
    [id],
  );
  if (!error) return res.status(404).json({ error: 'Error log not found' });

  const { rows: fixes } = await query(
    `SELECT * FROM fix_suggestions WHERE log_entry_id = $1 ORDER BY created_at DESC`,
    [id],
  );

  res.json({ ...error, fixes });
}

/**
 * POST /api/debug/ingest
 * Submit raw logs for error detection (queued)
 */
export async function ingestLogs(req, res) {
  const { workspaceId, rawLog, repoId } = req.body;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });
  if (!rawLog?.trim()) return res.status(400).json({ error: 'rawLog is required' });

  const job = await logProcessQueue.add('process-log', {
    rawLog,
    workspaceId,
    repoId: repoId || null,
  });

  res.json({ ok: true, jobId: job.id, message: 'Log queued for processing' });
}

/**
 * POST /api/debug/fix
 * Queue AI fix generation for an error
 */
export async function requestFix(req, res) {
  const { logEntryId, workspaceId } = req.body;
  if (!logEntryId || !workspaceId) {
    return res.status(400).json({ error: 'logEntryId and workspaceId are required' });
  }

  // Verify error belongs to workspace
  const { rows: [entry] } = await query(
    `SELECT id, status FROM log_entries WHERE id = $1 AND workspace_id = $2`,
    [logEntryId, workspaceId],
  );
  if (!entry) return res.status(404).json({ error: 'Error log not found' });
  if (entry.status === 'fixing') return res.status(409).json({ error: 'Fix already in progress' });

  const job = await fixGenerateQueue.add('generate-fix', {
    logEntryId,
    workspaceId,
    userId: req.user.id,
  });

  res.json({ ok: true, jobId: job.id });
}

/**
 * GET /api/debug/fixes
 * List all fix suggestions for a workspace
 */
export async function listFixes(req, res) {
  const { workspaceId, status } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  let sql = `
    SELECT fs.*, le.error_message, le.error_type, le.file_path, le.line_number
    FROM fix_suggestions fs
    JOIN log_entries le ON le.id = fs.log_entry_id
    WHERE fs.workspace_id = $1
  `;
  const params = [workspaceId];

  if (status) { params.push(status); sql += ` AND fs.status = $${params.length}`; }
  sql += ` ORDER BY fs.created_at DESC LIMIT 50`;

  const { rows } = await query(sql, params);
  res.json(rows);
}

/**
 * POST /api/debug/pr
 * Create a GitHub PR from an existing fix suggestion
 */
export async function createPR(req, res) {
  const { fixId, workspaceId } = req.body;
  if (!fixId || !workspaceId) {
    return res.status(400).json({ error: 'fixId and workspaceId are required' });
  }

  try {
    const result = await createPRFromFix({
      fixId,
      workspaceId,
      userId: req.user.id,
    });
    res.json(result);
  } catch (err) {
    logger.error('PR creation failed:', err.message);
    res.status(500).json({ error: err.message });
  }
}

/**
 * DELETE /api/debug/errors/:id
 * Dismiss / delete an error entry
 */
export async function dismissError(req, res) {
  const { id } = req.params;
  const { workspaceId } = req.query;

  await query(
    `UPDATE log_entries SET status = 'dismissed' WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  res.json({ ok: true });
}
// src/models/error-log.model.js
import { query } from '../config/database.js';

export const ErrorLogModel = {
  create: async ({ workspaceId, repoId, rawLog, level, errorType, errorMessage, stackTrace, filePath, lineNumber, metadata }) => {
    const { rows: [entry] } = await query(
      `INSERT INTO log_entries
       (workspace_id, repo_id, raw_log, level, error_type, error_message, stack_trace, file_path, line_number, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [workspaceId, repoId || null, rawLog, level, errorType, errorMessage, stackTrace, filePath, lineNumber, JSON.stringify(metadata || {})],
    );
    return entry;
  },

  findById: async (id) => {
    const { rows: [entry] } = await query(
      `SELECT le.*, r.repo_full_name FROM log_entries le
       LEFT JOIN repositories r ON r.id = le.repo_id
       WHERE le.id = $1`,
      [id],
    );
    return entry || null;
  },

  updateStatus: async (id, status) => {
    await query(`UPDATE log_entries SET status = $1 WHERE id = $2`, [status, id]);
  },

  markEmbedded: async (id, vectorId) => {
    await query(`UPDATE log_entries SET vector_id = $1 WHERE id = $2`, [vectorId, id]);
  },

  listForWorkspace: async (workspaceId, { status, repoId, level, limit = 50, offset = 0 } = {}) => {
    let sql = `
      SELECT le.*, r.repo_full_name FROM log_entries le
      LEFT JOIN repositories r ON r.id = le.repo_id
      WHERE le.workspace_id = $1
    `;
    const params = [workspaceId];
    if (status) { params.push(status); sql += ` AND le.status = $${params.length}`; }
    if (repoId) { params.push(repoId); sql += ` AND le.repo_id = $${params.length}`; }
    if (level)  { params.push(level);  sql += ` AND le.level = $${params.length}`; }
    params.push(limit, offset);
    sql += ` ORDER BY le.created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await query(sql, params);
    return rows;
  },

  countOpenForWorkspace: async (workspaceId) => {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS count FROM log_entries WHERE workspace_id = $1 AND status = 'open'`,
      [workspaceId],
    );
    return r.count;
  },

  createFixSuggestion: async ({ logEntryId, workspaceId, suggestedFix, explanation, filesChanged, sourcesUsed }) => {
    const { rows: [fix] } = await query(
      `INSERT INTO fix_suggestions (log_entry_id, workspace_id, suggested_fix, explanation, files_changed, sources_used)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [logEntryId, workspaceId, suggestedFix, explanation, JSON.stringify(filesChanged || []), JSON.stringify(sourcesUsed || [])],
    );
    return fix;
  },

  updateFixPR: async (fixId, prUrl, prNumber) => {
    await query(
      `UPDATE fix_suggestions SET pr_url = $1, pr_number = $2, status = 'pr_created' WHERE id = $3`,
      [prUrl, prNumber, fixId],
    );
  },

  listFixes: async (workspaceId, status) => {
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
    return rows;
  },
};
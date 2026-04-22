// src/models/deployment.model.js
import { query } from '../config/database.js';

export const DeploymentModel = {
  create: async ({ workspaceId, repoId, triggeredBy, envVars, platform, deployType }) => {
    const { rows: [dep] } = await query(
      `INSERT INTO deployments (workspace_id, repo_id, triggered_by, env_vars, platform, deploy_type)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
      [workspaceId, repoId, triggeredBy, JSON.stringify(envVars || {}), platform || null, deployType || null],
    );
    return dep;
  },

  findById: async (id) => {
    const { rows: [dep] } = await query(
      `SELECT d.*, r.repo_full_name FROM deployments d
       LEFT JOIN repositories r ON r.id = d.repo_id
       WHERE d.id = $1`,
      [id],
    );
    return dep || null;
  },

  updateStatus: async (id, status, { liveUrl, logs, deployId } = {}) => {
    await query(
      `UPDATE deployments
       SET status = $1, live_url = $2, logs = $3, deploy_id = $4, updated_at = NOW()
       WHERE id = $5`,
      [status, liveUrl || null, logs || null, deployId || null, id],
    );
  },

  listForWorkspace: async (workspaceId, { repoId, status, limit = 20 } = {}) => {
    let sql = `
      SELECT d.*, r.repo_full_name, r.detected_type, u.username AS triggered_by_username
      FROM deployments d
      LEFT JOIN repositories r ON r.id = d.repo_id
      LEFT JOIN users u ON u.id = d.triggered_by
      WHERE d.workspace_id = $1
    `;
    const params = [workspaceId];
    if (repoId) { params.push(repoId); sql += ` AND d.repo_id = $${params.length}`; }
    if (status)  { params.push(status);  sql += ` AND d.status = $${params.length}`; }
    params.push(limit);
    sql += ` ORDER BY d.created_at DESC LIMIT $${params.length}`;
    const { rows } = await query(sql, params);
    return rows;
  },

  getLatestForRepo: async (repoId) => {
    const { rows: [dep] } = await query(
      `SELECT * FROM deployments WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [repoId],
    );
    return dep || null;
  },
};
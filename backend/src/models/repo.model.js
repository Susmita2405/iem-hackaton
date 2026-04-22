// src/models/repo.model.js
import { query } from '../config/database.js';

export const RepoModel = {
  create: async ({ workspaceId, userId, repoUrl, repoFullName, defaultBranch }) => {
    const { rows: [repo] } = await query(
      `INSERT INTO repositories (workspace_id, user_id, repo_url, repo_full_name, default_branch)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [workspaceId, userId, repoUrl, repoFullName, defaultBranch || 'main'],
    );
    return repo;
  },

  findById: async (id) => {
    const { rows: [repo] } = await query(`SELECT * FROM repositories WHERE id = $1`, [id]);
    return repo || null;
  },

  findByFullName: async (repoFullName, workspaceId) => {
    const { rows: [repo] } = await query(
      `SELECT * FROM repositories WHERE repo_full_name = $1 AND workspace_id = $2`,
      [repoFullName, workspaceId],
    );
    return repo || null;
  },

  listForWorkspace: async (workspaceId) => {
    const { rows } = await query(
      `SELECT r.*, u.username AS added_by_username
       FROM repositories r
       LEFT JOIN users u ON u.id = r.user_id
       WHERE r.workspace_id = $1
       ORDER BY r.created_at DESC`,
      [workspaceId],
    );
    return rows;
  },

  updateAnalysis: async (id, { detectedType, detectedStack, localPath }) => {
    await query(
      `UPDATE repositories
       SET detected_type = $1, detected_stack = $2, local_path = $3, last_analyzed = NOW()
       WHERE id = $4`,
      [detectedType, JSON.stringify(detectedStack), localPath, id],
    );
  },

  updateVectorIds: async (id, vectorIds) => {
    await query(
      `UPDATE repositories SET vector_ids = $1 WHERE id = $2`,
      [vectorIds, id],
    );
  },

  delete: async (id, workspaceId) => {
    await query(
      `DELETE FROM repositories WHERE id = $1 AND workspace_id = $2`,
      [id, workspaceId],
    );
  },
};
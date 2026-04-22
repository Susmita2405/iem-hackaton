// src/models/workspace.model.js
import { query } from '../config/database.js';

export const WorkspaceModel = {
  findById: async (id) => {
    const { rows: [ws] } = await query(`SELECT * FROM workspaces WHERE id = $1`, [id]);
    return ws || null;
  },

  findBySlug: async (slug) => {
    const { rows: [ws] } = await query(`SELECT * FROM workspaces WHERE slug = $1`, [slug]);
    return ws || null;
  },

  listForUser: async (userId) => {
    const { rows } = await query(
      `SELECT w.*, wm.role
       FROM workspaces w
       JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
       ORDER BY w.created_at DESC`,
      [userId],
    );
    return rows;
  },

  create: async ({ ownerId, name, slug, namespace }) => {
    const { rows: [ws] } = await query(
      `INSERT INTO workspaces (owner_id, name, slug, pinecone_namespace)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [ownerId, name, slug, namespace],
    );
    return ws;
  },

  addMember: async (workspaceId, userId, role = 'member') => {
    await query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
      [workspaceId, userId, role],
    );
  },

  isMember: async (workspaceId, userId) => {
    const { rows: [m] } = await query(
      `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
      [workspaceId, userId],
    );
    return m || null;
  },

  delete: async (id) => {
    await query(`DELETE FROM workspaces WHERE id = $1`, [id]);
  },

  updateBotToken: async (id, botToken, webhookUrl) => {
    await query(
      `UPDATE workspaces SET telegram_bot_token = $1, telegram_webhook_url = $2, updated_at = NOW() WHERE id = $3`,
      [botToken, webhookUrl, id],
    );
  },
};
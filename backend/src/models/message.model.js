// src/models/message.model.js
import { query } from '../config/database.js';

export const MessageModel = {
  create: async ({ workspaceId, source, telegramMsgId, senderName, senderId, content, contentType, voiceFileId, metadata }) => {
    const { rows: [msg] } = await query(
      `INSERT INTO messages
       (workspace_id, source, telegram_msg_id, sender_name, sender_id, content, content_type, voice_file_id, metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING id`,
      [workspaceId, source, telegramMsgId || null, senderName, senderId, content, contentType || 'text', voiceFileId || null, JSON.stringify(metadata || {})],
    );
    return msg;
  },

  findById: async (id) => {
    const { rows: [msg] } = await query(`SELECT * FROM messages WHERE id = $1`, [id]);
    return msg || null;
  },

  updateContent: async (id, content) => {
    await query(`UPDATE messages SET content = $1 WHERE id = $2`, [content, id]);
  },

  markEmbedded: async (id, vectorId) => {
    await query(
      `UPDATE messages SET vector_id = $1, embedded_at = NOW() WHERE id = $2`,
      [vectorId, id],
    );
  },

  listForWorkspace: async (workspaceId, { source, limit = 50, offset = 0 } = {}) => {
    let sql = `SELECT id, source, sender_name, content, content_type, created_at, embedded_at
               FROM messages WHERE workspace_id = $1`;
    const params = [workspaceId];
    if (source) { params.push(source); sql += ` AND source = $${params.length}`; }
    params.push(limit, offset);
    sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await query(sql, params);
    return rows;
  },

  countForWorkspace: async (workspaceId) => {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS count FROM messages WHERE workspace_id = $1`,
      [workspaceId],
    );
    return r.count;
  },
};
// src/models/document.model.js
import { query } from '../config/database.js';

export const DocumentModel = {
  create: async ({ workspaceId, uploadedBy, fileName, fileType, fileSize, content }) => {
    const { rows: [doc] } = await query(
      `INSERT INTO documents (workspace_id, uploaded_by, file_name, file_type, file_size, content)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [workspaceId, uploadedBy, fileName, fileType, fileSize, content],
    );
    return doc;
  },

  findById: async (id) => {
    const { rows: [doc] } = await query(`SELECT * FROM documents WHERE id = $1`, [id]);
    return doc || null;
  },

  markEmbedded: async (id, vectorIds, chunkCount) => {
    await query(
      `UPDATE documents SET vector_ids = $1, chunk_count = $2, embedded_at = NOW() WHERE id = $3`,
      [vectorIds, chunkCount, id],
    );
  },

  listForWorkspace: async (workspaceId, limit = 30) => {
    const { rows } = await query(
      `SELECT d.id, d.file_name, d.file_type, d.file_size, d.chunk_count,
              d.embedded_at, d.created_at, u.username AS uploaded_by_username
       FROM documents d
       LEFT JOIN users u ON u.id = d.uploaded_by
       WHERE d.workspace_id = $1
       ORDER BY d.created_at DESC LIMIT $2`,
      [workspaceId, limit],
    );
    return rows;
  },

  delete: async (id, workspaceId) => {
    await query(`DELETE FROM documents WHERE id = $1 AND workspace_id = $2`, [id, workspaceId]);
  },

  countForWorkspace: async (workspaceId) => {
    const { rows: [r] } = await query(
      `SELECT COUNT(*)::int AS count FROM documents WHERE workspace_id = $1`,
      [workspaceId],
    );
    return r.count;
  },
};
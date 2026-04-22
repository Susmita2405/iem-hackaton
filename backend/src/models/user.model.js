// src/models/user.model.js
import { query } from '../config/database.js';

export const UserModel = {
  findById: async (id) => {
    const { rows: [user] } = await query(
      `SELECT id, github_id, username, email, avatar_url, created_at, updated_at
       FROM users WHERE id = $1`,
      [id],
    );
    return user || null;
  },

  findByGithubId: async (githubId) => {
    const { rows: [user] } = await query(
      `SELECT * FROM users WHERE github_id = $1`,
      [githubId],
    );
    return user || null;
  },

  upsertFromGithub: async ({ githubId, username, email, avatarUrl, githubToken }) => {
    const { rows: [user] } = await query(
      `INSERT INTO users (github_id, username, email, avatar_url, github_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_id)
       DO UPDATE SET username = $2, email = $3, avatar_url = $4, github_token = $5, updated_at = NOW()
       RETURNING *`,
      [githubId, username, email || null, avatarUrl, githubToken],
    );
    return user;
  },

  updateToken: async (id, githubToken) => {
    await query(
      `UPDATE users SET github_token = $1, updated_at = NOW() WHERE id = $2`,
      [githubToken, id],
    );
  },

  getPublicProfile: async (id) => {
    const { rows: [user] } = await query(
      `SELECT id, username, avatar_url, created_at FROM users WHERE id = $1`,
      [id],
    );
    return user || null;
  },
};
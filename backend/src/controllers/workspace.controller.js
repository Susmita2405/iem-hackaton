// src/controllers/workspace.controller.js
import { query, withTransaction } from '../config/database.js';
import { deleteNamespace } from '../config/pinecone.js';
import logger from '../utils/logger.js';

/**
 * POST /api/workspaces
 * Create a new workspace
 */
export async function createWorkspace(req, res) {
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name is required' });

  const slug = name.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 48)
    + '-' + Date.now().toString(36);

  const namespace = `ws-${slug.slice(0, 40)}`;

  const workspace = await withTransaction(async (client) => {
    const { rows: [ws] } = await client.query(
      `INSERT INTO workspaces (owner_id, name, slug, pinecone_namespace)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [req.user.id, name.trim(), slug, namespace],
    );

    await client.query(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')`,
      [ws.id, req.user.id],
    );

    return ws;
  });

  logger.info(`Workspace created: ${workspace.id} by user ${req.user.id}`);
  res.status(201).json(workspace);
}

/**
 * GET /api/workspaces
 * List workspaces the current user belongs to
 */
export async function listWorkspaces(req, res) {
  const { rows } = await query(
    `SELECT w.*, wm.role,
            (SELECT COUNT(*)::int FROM workspace_members WHERE workspace_id = w.id) AS member_count,
            (SELECT COUNT(*)::int FROM messages WHERE workspace_id = w.id) AS message_count,
            (SELECT COUNT(*)::int FROM documents WHERE workspace_id = w.id) AS document_count
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
     ORDER BY w.created_at DESC`,
    [req.user.id],
  );
  res.json(rows);
}

/**
 * GET /api/workspaces/:id
 * Get a single workspace with stats
 */
export async function getWorkspace(req, res) {
  const { id } = req.params;

  const { rows: [ws] } = await query(
    `SELECT w.*, wm.role
     FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = $1
     WHERE w.id = $2`,
    [req.user.id, id],
  );
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  // Get members
  const { rows: members } = await query(
    `SELECT wm.role, wm.joined_at, u.id, u.username, u.avatar_url
     FROM workspace_members wm
     JOIN users u ON u.id = wm.user_id
     WHERE wm.workspace_id = $1`,
    [id],
  );

  res.json({ ...ws, members });
}

/**
 * PATCH /api/workspaces/:id
 * Update workspace name
 */
export async function updateWorkspace(req, res) {
  const { id } = req.params;
  const { name } = req.body;

  // Only owner can update
  const { rows: [ws] } = await query(
    `SELECT owner_id FROM workspaces WHERE id = $1`,
    [id],
  );
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  if (ws.owner_id !== req.user.id) return res.status(403).json({ error: 'Only owner can update workspace' });

  const { rows: [updated] } = await query(
    `UPDATE workspaces SET name = $1, updated_at = NOW() WHERE id = $2 RETURNING *`,
    [name.trim(), id],
  );
  res.json(updated);
}

/**
 * DELETE /api/workspaces/:id
 * Delete workspace and all associated data
 */
export async function deleteWorkspace(req, res) {
  const { id } = req.params;

  const { rows: [ws] } = await query(
    `SELECT * FROM workspaces WHERE id = $1 AND owner_id = $2`,
    [id, req.user.id],
  );
  if (!ws) return res.status(404).json({ error: 'Workspace not found or not owner' });

  // Delete Pinecone namespace
  if (ws.pinecone_namespace) {
    try {
      await deleteNamespace(ws.pinecone_namespace);
    } catch (err) {
      logger.warn(`Failed to delete Pinecone namespace ${ws.pinecone_namespace}:`, err.message);
    }
  }

  // CASCADE deletes handle all related records
  await query(`DELETE FROM workspaces WHERE id = $1`, [id]);

  logger.info(`Workspace deleted: ${id}`);
  res.json({ ok: true });
}

/**
 * POST /api/workspaces/:id/invite
 * Invite a user to a workspace by GitHub username
 */
export async function inviteMember(req, res) {
  const { id } = req.params;
  const { username, role = 'member' } = req.body;

  if (!['member', 'admin'].includes(role)) {
    return res.status(400).json({ error: 'role must be member or admin' });
  }

  // Only owner/admin can invite
  const { rows: [requester] } = await query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [id, req.user.id],
  );
  if (!requester || !['owner', 'admin'].includes(requester.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // Find user
  const { rows: [invitedUser] } = await query(
    `SELECT id FROM users WHERE username = $1`,
    [username],
  );
  if (!invitedUser) return res.status(404).json({ error: 'User not found (they must have logged in once)' });

  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, user_id) DO NOTHING`,
    [id, invitedUser.id, role],
  );

  res.json({ ok: true });
}

/**
 * DELETE /api/workspaces/:id/members/:userId
 * Remove a member from a workspace
 */
export async function removeMember(req, res) {
  const { id, userId } = req.params;

  const { rows: [requester] } = await query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [id, req.user.id],
  );
  if (!requester || !['owner', 'admin'].includes(requester.role)) {
    return res.status(403).json({ error: 'Insufficient permissions' });
  }

  // Cannot remove the owner
  const { rows: [target] } = await query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [id, userId],
  );
  if (target?.role === 'owner') {
    return res.status(403).json({ error: 'Cannot remove workspace owner' });
  }

  await query(
    `DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [id, userId],
  );
  res.json({ ok: true });
}
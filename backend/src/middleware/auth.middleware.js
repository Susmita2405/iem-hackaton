// src/middleware/auth.middleware.js
import jwt from 'jsonwebtoken';
import { query } from '../config/database.js';

/**
 * Verify JWT and attach user to req.user
 */
export async function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing or invalid Authorization header' });
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    req.user = { id: payload.userId, username: payload.username };
    next();
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      return res.status(401).json({ error: 'Token expired' });
    }
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/**
 * Optional auth — attaches user if token present, continues either way
 */
export function optionalAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return next();

  try {
    const payload = jwt.verify(authHeader.slice(7), process.env.JWT_SECRET);
    req.user = { id: payload.userId, username: payload.username };
  } catch { /* ignore */ }

  next();
}

/**
 * Require workspace membership — attach after authMiddleware
 * Usage: router.get('/foo', authMiddleware, requireWorkspaceMember, handler)
 */
export function requireWorkspaceMember(req, res, next) {
  const workspaceId = req.body?.workspaceId || req.query?.workspaceId || req.params?.workspaceId;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  query(
    `SELECT role FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, req.user.id],
  ).then(({ rows: [member] }) => {
    if (!member) return res.status(403).json({ error: 'Not a member of this workspace' });
    req.workspaceMember = member;
    next();
  }).catch(next);
}
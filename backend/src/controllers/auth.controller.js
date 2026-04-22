// src/controllers/auth.controller.js
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

const JWT_SECRET       = process.env.JWT_SECRET;
const JWT_EXPIRES_IN   = '7d';
const GITHUB_CLIENT_ID = process.env.GITHUB_CLIENT_ID;
const GITHUB_CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET;

// Step 1: Redirect user to GitHub OAuth
export function githubLogin(req, res) {
  const scope = 'read:user user:email repo';
  const url = `https://github.com/login/oauth/authorize?client_id=${GITHUB_CLIENT_ID}&scope=${scope}`;
  res.redirect(url);
}

// Step 2: GitHub redirects back with code
export async function githubCallback(req, res) {
  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing OAuth code' });

  try {
    // Exchange code for access token
    const tokenRes = await axios.post(
      'https://github.com/login/oauth/access_token',
      { client_id: GITHUB_CLIENT_ID, client_secret: GITHUB_CLIENT_SECRET, code },
      { headers: { Accept: 'application/json' } },
    );

    const { access_token } = tokenRes.data;
    if (!access_token) throw new Error('No access token returned');

    // Fetch GitHub user profile
    const profileRes = await axios.get('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/vnd.github.v3+json' },
    });
    const profile = profileRes.data;

    // Upsert user in DB
    const { rows } = await query(
      `INSERT INTO users (github_id, username, email, avatar_url, github_token)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (github_id)
       DO UPDATE SET username = $2, avatar_url = $4, github_token = $5, updated_at = NOW()
       RETURNING *`,
      [
        profile.id.toString(),
        profile.login,
        profile.email || null,
        profile.avatar_url,
        access_token,
      ],
    );

    const user = rows[0];

    // Issue JWT
    const token = jwt.sign(
      { userId: user.id, username: user.username },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN },
    );

    // Redirect to frontend with token
    const redirectUrl = `${process.env.FRONTEND_URL}/auth/callback?token=${token}`;
    res.redirect(redirectUrl);
  } catch (err) {
    logger.error('GitHub OAuth error:', err.message);
    res.redirect(`${process.env.FRONTEND_URL}/login?error=oauth_failed`);
  }
}

export async function getMe(req, res) {
  const { rows } = await query(
    `SELECT id, username, email, avatar_url, created_at FROM users WHERE id = $1`,
    [req.user.id],
  );
  if (!rows.length) return res.status(404).json({ error: 'User not found' });
  res.json(rows[0]);
}

export async function logout(req, res) {
  // JWT is stateless — client just discards the token
  res.json({ ok: true });
}


// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/auth.middleware.js

import jwt from 'jsonwebtoken';

export function authMiddleware(req, res, next) {
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
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/secretDetect.middleware.js

import { maskSecrets } from '../utils/secretMask.js';

export function secretDetectMiddleware(req, res, next) {
  // Mask secrets in request body before they hit logs
  if (req.body && typeof req.body === 'object') {
    req.body = deepMask(req.body);
  }
  next();
}

function deepMask(obj) {
  if (typeof obj === 'string') return maskSecrets(obj);
  if (Array.isArray(obj)) return obj.map(deepMask);
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [k, v] of Object.entries(obj)) {
      result[k] = deepMask(v);
    }
    return result;
  }
  return obj;
}


// ─────────────────────────────────────────────────────────────────────────────
// src/middleware/error.middleware.js

import logger from '../utils/logger.js';

export function errorMiddleware(err, req, res, next) {
  logger.error('Unhandled error:', { message: err.message, stack: err.stack?.slice(0, 500) });

  const status = err.status || err.statusCode || 500;
  const message = process.env.NODE_ENV === 'production' && status === 500
    ? 'Internal server error'
    : err.message;

  res.status(status).json({ error: message });
}


// ─────────────────────────────────────────────────────────────────────────────
// src/utils/secretMask.js

const SECRET_PATTERNS = [
  // API keys
  /\b(sk-[a-zA-Z0-9]{32,})/g,
  /\b(pk-[a-zA-Z0-9]{32,})/g,
  // Generic high-entropy secrets (32+ hex chars)
  /\b([a-f0-9]{32,64})\b/g,
  // Tokens in key=value format
  /\b(token|secret|key|password|passwd|pwd|api_key|apikey)\s*[=:]\s*["']?([^\s"',}{]+)/gi,
  // Bearer tokens
  /Bearer\s+([a-zA-Z0-9\-._~+/]+=*)/g,
  // GitHub tokens
  /ghp_[a-zA-Z0-9]{36}/g,
  /github_pat_[a-zA-Z0-9_]{82}/g,
];

export function maskSecrets(text) {
  if (typeof text !== 'string') return text;
  let masked = text;
  for (const pattern of SECRET_PATTERNS) {
    masked = masked.replace(pattern, (match, ...groups) => {
      // Keep the key name visible, mask the value
      const value = groups[groups.length - 2]; // last captured group before offset
      if (!value || value.length < 8) return match;
      return match.replace(value, '***MASKED***');
    });
  }
  return masked;
}

export function containsSecret(text) {
  return SECRET_PATTERNS.some(p => new RegExp(p.source, p.flags).test(text));
}
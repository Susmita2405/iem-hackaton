// src/app.js
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

import authRoutes from './routes/auth.routes.js';
import workspaceRoutes from './routes/workspace.routes.js';
import ragRoutes from './routes/rag.routes.js';
import ingestRoutes from './routes/ingest.routes.js';
import githubRoutes from './routes/github.routes.js';
import deployRoutes from './routes/deploy.routes.js';
import debugRoutes from './routes/debug.routes.js';
import telegramRoutes from './routes/telegram.routes.js';
import { errorMiddleware } from './middleware/error.middleware.js';
import { secretDetectMiddleware } from './middleware/secretDetect.middleware.js';
import logger from './utils/logger.js';

const app = express();

// ── Security ──────────────────────────────────────────────────────────────────
app.use(helmet());
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

// ── Rate limiting ─────────────────────────────────────────────────────────────
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api', limiter);

// ── Body parsing ──────────────────────────────────────────────────────────────
// Raw body for Telegram webhook signature verification
app.use('/api/telegram', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

// ── Logging ───────────────────────────────────────────────────────────────────
app.use(morgan('combined', {
  stream: { write: (msg) => logger.info(msg.trim()) },
}));

// ── Secret detection (masks keys in logs) ─────────────────────────────────────
app.use(secretDetectMiddleware);

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({
  status: 'ok',
  service: 'SoumyaOps API',
  timestamp: new Date().toISOString(),
}));

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/workspaces', workspaceRoutes);
app.use('/api/rag', ragRoutes);
app.use('/api/ingest', ingestRoutes);
app.use('/api/github', githubRoutes);
app.use('/api/deploy', deployRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/telegram', telegramRoutes);

// ── Error handler ─────────────────────────────────────────────────────────────
app.use(errorMiddleware);

export default app;
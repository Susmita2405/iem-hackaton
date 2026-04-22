// src/routes/rag.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { ragLimiter } from '../middleware/rateLimit.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import {
  handleQuery,
  handleQueryStream,
  getHistory,
  getHistoryItem,
  getStats,
} from '../controllers/rag.controller.js';

const router = Router();
router.use(authMiddleware);

// Q&A — standard blocking response
router.post('/query',         ragLimiter, asyncHandler(handleQuery));

// Q&A — Server-Sent Events streaming
router.get('/query/stream',   ragLimiter, asyncHandler(handleQueryStream));

// Query history
router.get('/history',        asyncHandler(getHistory));
router.get('/history/:id',    asyncHandler(getHistoryItem));

// Usage statistics
router.get('/stats',          asyncHandler(getStats));

export default router;
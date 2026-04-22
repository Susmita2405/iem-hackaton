// src/routes/debug.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { ragLimiter, ingestLimiter } from '../middleware/rateLimit.middleware.js';
import {
  listErrors,
  getError,
  ingestLogs,
  requestFix,
  listFixes,
  createPR,
  dismissError,
} from '../controllers/debug.controller.js';
import { asyncHandler } from '../middleware/error.middleware.js';

const router = Router();
router.use(authMiddleware);

// Error entries
router.get('/errors',          asyncHandler(listErrors));
router.get('/errors/:id',      asyncHandler(getError));
router.delete('/errors/:id',   asyncHandler(dismissError));

// Log ingestion
router.post('/ingest', ingestLimiter, asyncHandler(ingestLogs));

// Fix generation
router.post('/fix', ragLimiter, asyncHandler(requestFix));
router.get('/fixes',           asyncHandler(listFixes));

// PR creation
router.post('/pr',             asyncHandler(createPR));

export default router;
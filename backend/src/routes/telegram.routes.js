// src/routes/telegram.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { webhookLimiter } from '../middleware/rateLimit.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import {
  handleWebhook,
  connectBot,
  disconnectBot,
  getBotStatus,
} from '../controllers/telegram.controller.js';

const router = Router();

// Webhook — no auth (Telegram calls this), raw body so we can verify signature
router.post(
  '/webhook/:workspaceSlug',
  webhookLimiter,
  asyncHandler(handleWebhook),
);

// Bot management — auth required
router.post('/connect',    authMiddleware, asyncHandler(connectBot));
router.post('/disconnect', authMiddleware, asyncHandler(disconnectBot));
router.get('/status',      authMiddleware, asyncHandler(getBotStatus));

export default router;
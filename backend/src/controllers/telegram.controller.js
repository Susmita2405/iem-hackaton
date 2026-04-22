// src/controllers/telegram.controller.js
import axios from 'axios';
import { processTelegramUpdate, setBotWebhook, deleteBotWebhook } from '../services/ingestion/telegram.ingest.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * POST /api/telegram/webhook/:workspaceSlug
 * Telegram sends all updates here — must respond 200 immediately
 */
export async function handleWebhook(req, res) {
  // Always respond immediately so Telegram doesn't retry
  res.status(200).json({ ok: true });

  const { workspaceSlug } = req.params;

  try {
    // Resolve workspace
    const { rows: [workspace] } = await query(
      `SELECT id, telegram_bot_token FROM workspaces WHERE slug = $1`,
      [workspaceSlug],
    );
    if (!workspace?.telegram_bot_token) {
      logger.warn(`Webhook received for unknown workspace slug: ${workspaceSlug}`);
      return;
    }

    // Verify secret token header (prevents spoofed requests)
    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    if (
      process.env.TELEGRAM_SECRET_TOKEN &&
      secretToken !== process.env.TELEGRAM_SECRET_TOKEN
    ) {
      logger.warn(`Invalid Telegram secret token for workspace: ${workspaceSlug}`);
      return;
    }

    // Parse update (body is raw buffer due to express.raw middleware)
    const update = typeof req.body === 'string'
      ? JSON.parse(req.body)
      : Buffer.isBuffer(req.body)
        ? JSON.parse(req.body.toString())
        : req.body;

    await processTelegramUpdate(update, workspace.id);
  } catch (err) {
    logger.error('Telegram webhook processing error:', err.message);
  }
}

/**
 * POST /api/telegram/connect
 * User registers their Telegram bot with a workspace
 */
export async function connectBot(req, res) {
  const { workspaceId, botToken } = req.body;

  if (!workspaceId || !botToken) {
    return res.status(400).json({ error: 'workspaceId and botToken are required' });
  }

  // Verify workspace ownership
  const { rows: [workspace] } = await query(
    `SELECT id, slug, owner_id FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });
  if (workspace.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'Only workspace owner can connect a bot' });
  }

  try {
    // Validate token via Telegram getMe
    const meRes = await axios.get(
      `https://api.telegram.org/bot${botToken}/getMe`,
    );
    if (!meRes.data.ok) throw new Error('Invalid bot token');
    const botInfo = meRes.data.result;

    // Set webhook
    const webhookUrl = `${process.env.API_BASE_URL}/api/telegram/webhook/${workspace.slug}`;
    const webhookResult = await setBotWebhook(botToken, webhookUrl);

    if (!webhookResult.ok) {
      throw new Error(`Webhook setup failed: ${webhookResult.description}`);
    }

    // Store in DB
    await query(
      `UPDATE workspaces
       SET telegram_bot_token = $1, telegram_webhook_url = $2, updated_at = NOW()
       WHERE id = $3`,
      [botToken, webhookUrl, workspaceId],
    );

    logger.info(`Telegram bot @${botInfo.username} connected to workspace ${workspaceId}`);

    res.json({
      ok: true,
      botUsername: botInfo.username,
      botId: botInfo.id,
      webhookUrl,
    });
  } catch (err) {
    logger.error('Telegram connect error:', err.message);
    res.status(400).json({ error: err.message });
  }
}

/**
 * POST /api/telegram/disconnect
 * Remove bot from workspace and delete webhook
 */
export async function disconnectBot(req, res) {
  const { workspaceId } = req.body;

  const { rows: [workspace] } = await query(
    `SELECT telegram_bot_token FROM workspaces WHERE id = $1 AND owner_id = $2`,
    [workspaceId, req.user.id],
  );
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  if (workspace.telegram_bot_token) {
    try {
      await deleteBotWebhook(workspace.telegram_bot_token);
    } catch (err) {
      logger.warn('Failed to delete webhook:', err.message);
    }
  }

  await query(
    `UPDATE workspaces
     SET telegram_bot_token = NULL, telegram_webhook_url = NULL, updated_at = NOW()
     WHERE id = $1`,
    [workspaceId],
  );

  res.json({ ok: true });
}

/**
 * GET /api/telegram/status
 * Get the bot connection status for a workspace
 */
export async function getBotStatus(req, res) {
  const { workspaceId } = req.query;

  const { rows: [workspace] } = await query(
    `SELECT telegram_bot_token, telegram_webhook_url FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  if (!workspace) return res.status(404).json({ error: 'Workspace not found' });

  if (!workspace.telegram_bot_token) {
    return res.json({ connected: false });
  }

  try {
    const meRes = await axios.get(
      `https://api.telegram.org/bot${workspace.telegram_bot_token}/getMe`,
    );
    const whRes = await axios.get(
      `https://api.telegram.org/bot${workspace.telegram_bot_token}/getWebhookInfo`,
    );

    res.json({
      connected: true,
      botUsername: meRes.data.result?.username,
      webhookUrl: whRes.data.result?.url,
      pendingUpdates: whRes.data.result?.pending_update_count,
    });
  } catch {
    res.json({ connected: false, error: 'Bot token may be invalid' });
  }
}
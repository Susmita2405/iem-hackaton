// src/services/ingestion/whisper.service.js
// Transcribes voice notes from Telegram using OpenAI Whisper

import axios from 'axios';
import OpenAI from 'openai';
import { getBotFileUrl } from './telegram.ingest.js';
import logger from '../../utils/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Download voice file from Telegram and transcribe with Whisper
 * @param {string} fileId   - Telegram file_id
 * @param {string} botToken
 * @returns {string} Transcribed text
 */
export async function transcribeVoice(fileId, botToken) {
  // Get Telegram download URL
  const fileUrl = await getBotFileUrl(fileId, botToken);

  // Download as buffer
  const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
  const audioBuffer = Buffer.from(response.data);

  // Whisper expects a File object — create from buffer
  const audioFile = new File([audioBuffer], 'voice.ogg', { type: 'audio/ogg' });

  const transcription = await openai.audio.transcriptions.create({
    file: audioFile,
    model: 'whisper-1',
    language: 'en', // Can be made configurable per workspace
    response_format: 'text',
  });

  logger.info(`Whisper transcribed ${audioBuffer.length} bytes`);
  return transcription.trim();
}


// ─────────────────────────────────────────────────────────────────────────────
// src/controllers/telegram.controller.js
import crypto from 'crypto';
import { processTelegramUpdate } from '../services/ingestion/telegram.ingest.js';
import { setBotWebhook, deleteBotWebhook } from '../services/ingestion/telegram.ingest.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * POST /api/telegram/webhook/:workspaceSlug
 * Telegram sends all updates here
 */
export async function handleWebhook(req, res) {
  // Always respond 200 immediately to Telegram (it retries on timeout)
  res.json({ ok: true });

  const { workspaceSlug } = req.params;

  try {
    // Look up workspace
    const { rows } = await query(
      `SELECT id, telegram_bot_token FROM workspaces WHERE slug = $1`,
      [workspaceSlug],
    );
    if (!rows.length) return;

    const workspace = rows[0];

    // Verify Telegram secret token (optional but recommended)
    const secretToken = req.headers['x-telegram-bot-api-secret-token'];
    if (process.env.TELEGRAM_SECRET_TOKEN && secretToken !== process.env.TELEGRAM_SECRET_TOKEN) {
      logger.warn('Telegram webhook: invalid secret token');
      return;
    }

    const update = JSON.parse(req.body.toString());
    await processTelegramUpdate(update, workspace.id);
  } catch (err) {
    logger.error('Telegram webhook handler error:', err.message);
  }
}

/**
 * POST /api/telegram/connect
 * User connects their Telegram bot to a workspace
 */
export async function connectBot(req, res) {
  const { workspaceId, botToken } = req.body;
  const userId = req.user.id;

  try {
    // Validate bot token by calling getMe
    const botInfo = await validateBotToken(botToken);

    const webhookUrl = `${process.env.API_BASE_URL}/api/telegram/webhook/${req.body.workspaceSlug}`;
    await setBotWebhook(botToken, webhookUrl);

    // Store encrypted token
    await query(
      `UPDATE workspaces 
       SET telegram_bot_token = $1, telegram_webhook_url = $2, updated_at = NOW()
       WHERE id = $3 AND owner_id = $4`,
      [botToken, webhookUrl, workspaceId, userId],
    );

    res.json({ ok: true, botUsername: botInfo.username, webhookUrl });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
}

async function validateBotToken(token) {
  const axios = (await import('axios')).default;
  const res = await axios.get(`https://api.telegram.org/bot${token}/getMe`);
  if (!res.data.ok) throw new Error('Invalid bot token');
  return res.data.result;
}
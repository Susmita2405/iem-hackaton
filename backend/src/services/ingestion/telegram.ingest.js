// src/services/ingestion/telegram.ingest.js
// Handles Telegram webhook events — messages, voice notes, documents

import axios from 'axios';
import FormData from 'form-data';
import { query, withTransaction } from '../../config/database.js';
import { embedQueue } from '../../jobs/queue.js';
import logger from '../../utils/logger.js';
import { maskSecrets } from '../../utils/secretMask.js';

/**
 * Process an incoming Telegram update
 * Called from the webhook controller after signature verification
 */
export async function processTelegramUpdate(update, workspaceId) {
  const message = update.message || update.edited_message;
  if (!message) return; // Ignore non-message updates (reactions, etc.)

  const { message_id, from, text, voice, document, date } = message;

  try {
    if (text) {
      await processTextMessage({ message_id, from, text, date, workspaceId });
    } else if (voice) {
      await processVoiceMessage({ message_id, from, voice, date, workspaceId });
    } else if (document) {
      await processDocumentMessage({ message_id, from, document, date, workspaceId });
    }
  } catch (err) {
    logger.error('Telegram message processing failed:', err.message);
  }
}

// ── Text messages ─────────────────────────────────────────────────────────────
async function processTextMessage({ message_id, from, text, date, workspaceId }) {
  const safeContent = maskSecrets(text);

  const { rows } = await query(
    `INSERT INTO messages 
     (workspace_id, source, telegram_msg_id, sender_name, sender_id, content, content_type, metadata, created_at)
     VALUES ($1, 'telegram', $2, $3, $4, $5, 'text', $6, to_timestamp($7))
     RETURNING id`,
    [
      workspaceId,
      message_id,
      from?.first_name ? `${from.first_name} ${from.last_name || ''}`.trim() : 'Unknown',
      from?.id?.toString(),
      safeContent,
      JSON.stringify({ fromId: from?.id, username: from?.username }),
      date,
    ],
  );

  const messageId = rows[0].id;

  // Queue embedding job (async — don't block webhook response)
  await embedQueue.add('embed-message', {
    type: 'message',
    messageId,
    content: safeContent,
    source: 'telegram',
    workspaceId,
    metadata: {
      messageId,
      source: 'telegram',
      workspaceId,
      senderName: from?.first_name || 'Unknown',
      timestamp: new Date(date * 1000).toISOString(),
    },
  });

  logger.info(`Telegram text message stored: ${messageId}`);
}

// ── Voice messages ────────────────────────────────────────────────────────────
async function processVoiceMessage({ message_id, from, voice, date, workspaceId }) {
  // First, store a placeholder
  const { rows } = await query(
    `INSERT INTO messages
     (workspace_id, source, telegram_msg_id, sender_name, sender_id, content, content_type, voice_file_id, metadata, created_at)
     VALUES ($1, 'telegram', $2, $3, $4, '[Voice note — transcribing...]', 'voice', $5, $6, to_timestamp($7))
     RETURNING id`,
    [
      workspaceId,
      message_id,
      from?.first_name ? `${from.first_name} ${from.last_name || ''}`.trim() : 'Unknown',
      from?.id?.toString(),
      voice.file_id,
      JSON.stringify({ fileId: voice.file_id, duration: voice.duration }),
      date,
    ],
  );

  const messageId = rows[0].id;

  // Queue whisper transcription (will update message + trigger embed after)
  await embedQueue.add('transcribe-voice', {
    type: 'voice',
    messageId,
    fileId: voice.file_id,
    workspaceId,
    source: 'telegram',
    senderName: from?.first_name || 'Unknown',
    timestamp: new Date(date * 1000).toISOString(),
  });

  logger.info(`Telegram voice message queued for transcription: ${messageId}`);
}

// ── Document messages ─────────────────────────────────────────────────────────
async function processDocumentMessage({ message_id, from, document, date, workspaceId }) {
  const { mime_type, file_name, file_id } = document;

  // Only process text-readable documents
  const supported = ['text/plain', 'application/json', 'text/markdown'];
  if (!supported.includes(mime_type)) {
    logger.info(`Skipping unsupported document type: ${mime_type}`);
    return;
  }

  await embedQueue.add('ingest-telegram-doc', {
    type: 'telegram_document',
    fileId: file_id,
    fileName: file_name,
    mimeType: mime_type,
    workspaceId,
    messageId: message_id,
    senderName: from?.first_name || 'Unknown',
    timestamp: new Date(date * 1000).toISOString(),
  });

  logger.info(`Telegram document queued for ingestion: ${file_name}`);
}

// ── Telegram Bot API helpers ───────────────────────────────────────────────────
export async function getBotFileUrl(fileId, botToken) {
  const res = await axios.get(
    `https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`,
  );
  const filePath = res.data.result.file_path;
  return `https://api.telegram.org/file/bot${botToken}/${filePath}`;
}

export async function setBotWebhook(botToken, webhookUrl) {
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/setWebhook`,
    { url: webhookUrl, allowed_updates: ['message', 'edited_message'] },
  );
  return res.data;
}

export async function deleteBotWebhook(botToken) {
  const res = await axios.post(
    `https://api.telegram.org/bot${botToken}/deleteWebhook`,
  );
  return res.data;
}
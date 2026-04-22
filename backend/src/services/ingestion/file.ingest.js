// src/services/ingestion/file.ingest.js
// Handles .txt, .json, .md, .csv file ingestion

import { DocumentModel } from '../../models/document.model.js';
import { embedQueue } from '../../jobs/queue.js';
import { query } from '../../config/database.js';
import { maskSecrets } from '../../utils/secretMask.js';
import logger from '../../utils/logger.js';

/**
 * Ingest an uploaded file — store in DB and queue embedding
 * @param {object} params
 * @param {Buffer} params.buffer     - File content as Buffer
 * @param {string} params.fileName
 * @param {string} params.mimeType
 * @param {string} params.workspaceId
 * @param {string} params.userId
 * @returns {{ documentId, chunkCount }}
 */
export async function ingestFile({ buffer, fileName, mimeType, workspaceId, userId }) {
  const content = extractContent(buffer, mimeType, fileName);
  const safeContent = maskSecrets(content);

  const estimatedChunks = Math.ceil(safeContent.length / 800);

  // Store in DB
  const doc = await DocumentModel.create({
    workspaceId,
    uploadedBy: userId,
    fileName,
    fileType: mimeType,
    fileSize: buffer.length,
    content: safeContent,
  });

  // Get workspace namespace
  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
    [workspaceId],
  );
  const namespace = ws?.pinecone_namespace || workspaceId;

  // Queue embedding job
  await embedQueue.add('embed-message', {
    type: 'document',
    documentId: doc.id,
    content: safeContent,
    source: detectSource(mimeType, fileName),
    workspaceId,
    namespace,
    metadata: {
      source: 'document',
      workspaceId,
      documentId: doc.id,
      fileName,
      mimeType,
      timestamp: new Date().toISOString(),
    },
  });

  logger.info(`[file-ingest] Queued: ${fileName} (${buffer.length} bytes, doc: ${doc.id})`);

  return { documentId: doc.id, chunkCount: estimatedChunks };
}

// ── Content extractors ────────────────────────────────────────────────────────
function extractContent(buffer, mimeType, fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();

  if (mimeType === 'application/json' || ext === 'json') {
    return extractJson(buffer);
  }
  if (ext === 'csv' || mimeType === 'text/csv') {
    return extractCsv(buffer);
  }

  // Default: treat as plain text (txt, md, etc.)
  return buffer.toString('utf-8');
}

function extractJson(buffer) {
  try {
    const raw = buffer.toString('utf-8');
    const obj = JSON.parse(raw);

    // Flatten JSON to readable text for embedding
    return flattenJson(obj);
  } catch {
    return buffer.toString('utf-8');
  }
}

function flattenJson(obj, prefix = '', depth = 0) {
  if (depth > 4) return JSON.stringify(obj);
  if (typeof obj === 'string') return obj;
  if (typeof obj === 'number' || typeof obj === 'boolean') return String(obj);

  const lines = [];

  if (Array.isArray(obj)) {
    obj.forEach((item, i) => {
      lines.push(flattenJson(item, `${prefix}[${i}]`, depth + 1));
    });
  } else if (obj && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === 'object' && value !== null) {
        lines.push(`${fullKey}:`);
        lines.push(flattenJson(value, fullKey, depth + 1));
      } else {
        lines.push(`${fullKey}: ${value}`);
      }
    }
  }

  return lines.join('\n');
}

function extractCsv(buffer) {
  const text = buffer.toString('utf-8');
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length === 0) return text;

  // Keep headers visible for context, convert rows to readable sentences
  const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
  const rows = lines.slice(1).map(row => {
    const values = row.split(',').map(v => v.trim().replace(/^"|"$/g, ''));
    return headers.map((h, i) => `${h}: ${values[i] || ''}`).join(', ');
  });

  return `CSV Data (${rows.length} rows, columns: ${headers.join(', ')})\n\n${rows.join('\n')}`;
}

// ── Source type detection ─────────────────────────────────────────────────────
function detectSource(mimeType, fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  if (ext === 'md' || ext === 'mdx') return 'document';
  if (ext === 'json') return 'document';
  if (ext === 'csv') return 'document';
  return 'document';
}
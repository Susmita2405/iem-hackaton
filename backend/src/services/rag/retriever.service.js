// src/services/rag/retriever.service.js
// Hybrid retrieval: Pinecone vector search + PostgreSQL full-text keyword search

import { getPineconeIndex } from '../../config/pinecone.js';
import { embedQuery } from './embedder.service.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

/**
 * Hybrid retrieval — combines vector similarity + keyword matches
 * @param {string} queryText  - User's question
 * @param {string} namespace  - Workspace Pinecone namespace
 * @param {string} workspaceId
 * @param {object} filters    - Optional: { source: 'telegram', dateFrom: '...' }
 * @param {number} topK       - Number of results
 */
export async function hybridRetrieve(queryText, namespace, workspaceId, filters = {}, topK = 10) {
  const [vectorResults, keywordResults] = await Promise.all([
    vectorSearch(queryText, namespace, filters, topK),
    keywordSearch(queryText, workspaceId, filters, topK),
  ]);

  return mergeAndDeduplicate(vectorResults, keywordResults, topK);
}

// ── Vector search ─────────────────────────────────────────────────────────────
async function vectorSearch(queryText, namespace, filters, topK) {
  try {
    const queryVector = await embedQuery(queryText);
    const index = getPineconeIndex(namespace);

    // Build Pinecone metadata filter
    const pineconeFilter = {};
    if (filters.source) pineconeFilter.source = { $eq: filters.source };
    if (filters.senderName) pineconeFilter.senderName = { $eq: filters.senderName };
    if (filters.dateFrom) pineconeFilter.timestamp = { $gte: filters.dateFrom };

    const response = await index.query({
      vector: queryVector,
      topK,
      includeMetadata: true,
      filter: Object.keys(pineconeFilter).length ? pineconeFilter : undefined,
    });

    return response.matches.map(match => ({
      id: match.id,
      score: match.score,
      text: match.metadata.text,
      source: match.metadata.source,
      fileName: match.metadata.fileName,
      senderName: match.metadata.senderName,
      timestamp: match.metadata.timestamp,
      messageId: match.metadata.messageId,
      documentId: match.metadata.documentId,
      retrievalMethod: 'vector',
    }));
  } catch (err) {
    logger.error('Vector search failed:', err.message);
    return [];
  }
}

// ── Keyword search (PostgreSQL full-text) ─────────────────────────────────────
async function keywordSearch(queryText, workspaceId, filters, topK) {
  try {
    // Normalize query for tsquery
    const tsQuery = queryText
      .replace(/[^a-zA-Z0-9 ]/g, ' ')
      .trim()
      .split(/\s+/)
      .filter(w => w.length > 2)
      .join(' & ');

    if (!tsQuery) return [];

    let sql = `
      SELECT
        id::text AS id,
        content AS text,
        source,
        sender_name AS "senderName",
        created_at AS timestamp,
        id::text AS "messageId",
        NULL AS "documentId",
        NULL AS "fileName",
        ts_rank(to_tsvector('english', content), to_tsquery('english', $1)) AS score
      FROM messages
      WHERE workspace_id = $2
        AND to_tsvector('english', content) @@ to_tsquery('english', $1)
    `;
    const params = [tsQuery, workspaceId];

    if (filters.source) {
      params.push(filters.source);
      sql += ` AND source = $${params.length}`;
    }

    sql += ` ORDER BY score DESC LIMIT $${params.length + 1}`;
    params.push(topK);

    const { rows } = await query(sql, params);
    return rows.map(r => ({ ...r, retrievalMethod: 'keyword' }));
  } catch (err) {
    logger.error('Keyword search failed:', err.message);
    return [];
  }
}

// ── Merge & deduplicate ───────────────────────────────────────────────────────
function mergeAndDeduplicate(vectorResults, keywordResults, topK) {
  const seen = new Set();
  const merged = [];

  // Interleave: take vector first (higher semantic quality), then keyword
  const all = [...vectorResults, ...keywordResults];

  for (const result of all) {
    const dedupeKey = result.messageId || result.documentId || result.text.slice(0, 80);
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    // Boost score slightly if found by both methods
    const alreadySeen = vectorResults.find(v => v.text === result.text)
      && keywordResults.find(k => k.text === result.text);
    merged.push({ ...result, score: alreadySeen ? result.score * 1.2 : result.score });
  }

  return merged
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}
// src/services/rag/embedder.service.js
// Generates OpenAI embeddings and stores in Pinecone with metadata

import OpenAI from 'openai';
import { getPineconeIndex } from '../../config/pinecone.js';
import { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS } from '../../config/anthropic.js';
import logger from '../../utils/logger.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Embed chunks and upsert to Pinecone
 * @param {Array} chunks - [{pageContent, metadata}]
 * @param {string} namespace - Pinecone namespace (workspace slug)
 * @returns {string[]} vector IDs
 */
export async function embedAndStore(chunks, namespace) {
  if (!chunks.length) return [];

  const index = getPineconeIndex(namespace);
  const vectorIds = [];

  // Batch in groups of 100 (Pinecone upsert limit)
  const BATCH_SIZE = 100;
  for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
    const batch = chunks.slice(i, i + BATCH_SIZE);

    // Generate embeddings
    const texts = batch.map(c => c.pageContent);
    const embeddingResponse = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: texts,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    // Build Pinecone vectors
    const vectors = batch.map((chunk, j) => {
      const id = `${chunk.metadata.source}_${chunk.metadata.documentId || 'doc'}_${i + j}_${Date.now()}`;
      vectorIds.push(id);
      return {
        id,
        values: embeddingResponse.data[j].embedding,
        metadata: {
          // All metadata stored here for hybrid filtering
          text: chunk.pageContent.slice(0, 2000), // Pinecone metadata limit
          source: chunk.metadata.source || 'unknown',
          workspaceId: chunk.metadata.workspaceId,
          documentId: chunk.metadata.documentId || null,
          messageId: chunk.metadata.messageId || null,
          fileName: chunk.metadata.fileName || null,
          senderName: chunk.metadata.senderName || null,
          chunkStrategy: chunk.metadata.chunkStrategy,
          timestamp: chunk.metadata.timestamp || new Date().toISOString(),
          language: chunk.metadata.language || null,
          charCount: chunk.pageContent.length,
        },
      };
    });

    await index.upsert(vectors);
    logger.info(`Embedded batch ${i}–${i + batch.length} (${namespace})`);
  }

  return vectorIds;
}

/**
 * Generate embedding for a query string (no storage)
 */
export async function embedQuery(text) {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });
  return response.data[0].embedding;
}
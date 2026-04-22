// src/config/pinecone.js
import { Pinecone } from '@pinecone-database/pinecone';

let pineconeClient;

export function getPinecone() {
  if (!pineconeClient) {
    pineconeClient = new Pinecone({
      apiKey: process.env.PINECONE_API_KEY,
    });
  }
  return pineconeClient;
}

// Get an index with optional namespace isolation per workspace
export function getPineconeIndex(namespace = null) {
  const client = getPinecone();
  const index = client.index(process.env.PINECONE_INDEX_NAME || 'soumyaops');
  return namespace ? index.namespace(namespace) : index;
}


// src/config/anthropic.js
import Anthropic from '@anthropic-ai/sdk';

let anthropicClient;

export function getAnthropic() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
    });
  }
  return anthropicClient;
}

export const CLAUDE_MODEL = 'claude-sonnet-4-20250514';
export const EMBEDDING_MODEL = 'text-embedding-3-large'; // via OpenAI for embeddings
export const EMBEDDING_DIMENSIONS = 3072;
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
export const EMBEDDING_MODEL = 'text-embedding-3-large';
export const EMBEDDING_DIMENSIONS = 3072;
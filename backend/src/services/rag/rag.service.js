// src/services/rag/rag.service.js
// Orchestrates the complete RAG pipeline: Retrieve → Re-rank → Build → Generate

import { hybridRetrieve } from './retriever.service.js';
import { mmrRerank } from './reranker.service.js';
import { buildContext } from './reranker.service.js';
import { getAnthropic, CLAUDE_MODEL } from '../../config/anthropic.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

/**
 * Full RAG pipeline — the main entrypoint for answering questions
 * @param {object} params
 * @param {string} params.question    - User's question
 * @param {string} params.workspaceId
 * @param {string} params.namespace   - Pinecone namespace
 * @param {string} params.userId
 * @param {object} params.filters     - Optional source/date filters
 * @returns {{ answer: string, sources: Array, tokensUsed: number }}
 */
export async function ragQuery({ question, workspaceId, namespace, userId, filters = {} }) {
  const startTime = Date.now();

  logger.info(`RAG query: "${question.slice(0, 80)}" (workspace: ${workspaceId})`);

  // ── Step 1: Hybrid Retrieval ──────────────────────────────────────────────
  const retrieved = await hybridRetrieve(
    question,
    namespace,
    workspaceId,
    filters,
    15, // Fetch more, then re-rank down
  );

  if (retrieved.length === 0) {
    return {
      answer: "I couldn't find relevant information in your team's knowledge base for this question. Try ingesting more data or rephrasing.",
      sources: [],
      tokensUsed: 0,
    };
  }

  // ── Step 2: MMR Re-ranking ────────────────────────────────────────────────
  const reranked = await mmrRerank(retrieved, question, 5, 0.7);

  // ── Step 3: Build Context ─────────────────────────────────────────────────
  const { systemPrompt, userPrompt, sources } = buildContext(reranked, question);

  // ── Step 4: Generate with Claude ──────────────────────────────────────────
  const anthropic = getAnthropic();
  const response = await anthropic.messages.create({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  const answer = response.content[0].text;
  const tokensUsed = response.usage.input_tokens + response.usage.output_tokens;
  const latencyMs = Date.now() - startTime;

  // ── Step 5: Store query history ───────────────────────────────────────────
  const sourcesForDB = sources.map(s => ({
    id: s.id,
    source: s.source,
    excerpt: s.text.slice(0, 200),
    score: s.score,
    fileName: s.fileName,
    senderName: s.senderName,
    timestamp: s.timestamp,
  }));

  await query(
    `INSERT INTO rag_queries (workspace_id, user_id, question, answer, sources, tokens_used, latency_ms)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [workspaceId, userId, question, answer, JSON.stringify(sourcesForDB), tokensUsed, latencyMs],
  );

  logger.info(`RAG complete in ${latencyMs}ms, ${tokensUsed} tokens, ${sources.length} sources`);

  return { answer, sources: sourcesForDB, tokensUsed, latencyMs };
}

/**
 * Streaming RAG — for real-time chat UI
 */
export async function ragQueryStream({ question, workspaceId, namespace, userId, filters = {}, onChunk }) {
  const retrieved = await hybridRetrieve(question, namespace, workspaceId, filters, 15);
  const reranked = await mmrRerank(retrieved, question, 5, 0.7);
  const { systemPrompt, userPrompt, sources } = buildContext(reranked, question);

  const anthropic = getAnthropic();
  let fullAnswer = '';

  const stream = anthropic.messages.stream({
    model: CLAUDE_MODEL,
    max_tokens: 1500,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
  });

  stream.on('text', (text) => {
    fullAnswer += text;
    onChunk({ type: 'text', text });
  });

  await stream.finalMessage();

  // Emit sources at the end
  onChunk({ type: 'sources', sources: sources.map(s => ({
    id: s.id,
    source: s.source,
    excerpt: s.text.slice(0, 200),
    score: s.score,
    fileName: s.fileName,
    senderName: s.senderName,
  }))});

  return { answer: fullAnswer, sources };
}
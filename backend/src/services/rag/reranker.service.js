// src/services/rag/reranker.service.js
// MMR (Maximal Marginal Relevance) re-ranking to improve diversity + relevance

import { embedQuery } from './embedder.service.js';

/**
 * Re-rank results using MMR — balances relevance vs diversity
 * Prevents the LLM from getting 5 near-identical chunks
 * @param {Array} results - Retrieved chunks with .score
 * @param {string} queryText
 * @param {number} topN - How many to return after re-ranking
 * @param {number} lambda - 0 = max diversity, 1 = max relevance (default 0.7)
 */
export async function mmrRerank(results, queryText, topN = 5, lambda = 0.7) {
  if (results.length <= topN) return results;

  // Assign relevance scores (already have from retrieval)
  // For a full implementation, we'd compute cosine similarity to query
  // Here we use the retrieved scores + a simple diversity penalty

  const selected = [];
  const candidates = [...results];

  while (selected.length < topN && candidates.length > 0) {
    let bestIdx = 0;
    let bestScore = -Infinity;

    for (let i = 0; i < candidates.length; i++) {
      const relevance = candidates[i].score;

      // Diversity penalty: how similar is this to already-selected results?
      let maxSimilarity = 0;
      for (const sel of selected) {
        const sim = textSimilarity(candidates[i].text, sel.text);
        maxSimilarity = Math.max(maxSimilarity, sim);
      }

      // MMR score: trade off relevance vs redundancy
      const mmrScore = lambda * relevance - (1 - lambda) * maxSimilarity;

      if (mmrScore > bestScore) {
        bestScore = mmrScore;
        bestIdx = i;
      }
    }

    selected.push(candidates[bestIdx]);
    candidates.splice(bestIdx, 1);
  }

  return selected;
}

// Approximate text similarity via Jaccard on word sets
function textSimilarity(a, b) {
  const setA = new Set(a.toLowerCase().split(/\s+/));
  const setB = new Set(b.toLowerCase().split(/\s+/));
  const intersection = [...setA].filter(w => setB.has(w)).length;
  const union = new Set([...setA, ...setB]).size;
  return union === 0 ? 0 : intersection / union;
}


// ─────────────────────────────────────────────────────────────────────────────
// src/services/rag/context-builder.service.js
// Builds the structured prompt context from re-ranked chunks

export function buildContext(rankedChunks, question) {
  const sourceList = rankedChunks.map((chunk, i) => {
    const sourceLabel = formatSourceLabel(chunk);
    return `[Source ${i + 1}] ${sourceLabel}\n${chunk.text.trim()}`;
  }).join('\n\n---\n\n');

  const systemPrompt = `You are SoumyaOps AI — a knowledgeable assistant for development teams.
You answer questions STRICTLY based on the provided context from your team's knowledge base.
You MUST cite sources using [Source N] notation.
If the context doesn't contain enough information to answer, say so clearly — do not hallucinate.
Always be specific, technical, and actionable.`;

  const userPrompt = `CONTEXT FROM KNOWLEDGE BASE:
${sourceList}

---

QUESTION: ${question}

Answer the question based ONLY on the context above. Cite sources like [Source 1], [Source 2] etc.
At the end, list the sources you used under "## Sources Used".`;

  return { systemPrompt, userPrompt, sources: rankedChunks };
}

function formatSourceLabel(chunk) {
  const parts = [];
  if (chunk.source === 'telegram') parts.push(`📨 Telegram`);
  else if (chunk.source === 'code') parts.push(`💻 Code`);
  else if (chunk.source === 'logs') parts.push(`📋 Log`);
  else parts.push(`📄 Document`);

  if (chunk.senderName) parts.push(`from ${chunk.senderName}`);
  if (chunk.fileName) parts.push(`(${chunk.fileName})`);
  if (chunk.timestamp) {
    const d = new Date(chunk.timestamp);
    if (!isNaN(d)) parts.push(`at ${d.toLocaleDateString()}`);
  }
  return parts.join(' ');
}
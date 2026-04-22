// src/services/rag/context-builder.service.js
// Assembles retrieved + re-ranked chunks into a structured LLM prompt
// with full source attribution

/**
 * Build a structured system + user prompt from re-ranked RAG chunks
 *
 * @param {Array}  rankedChunks  - Re-ranked result objects from retriever + reranker
 * @param {string} question      - The user's original question
 * @param {object} options
 * @param {string} options.persona        - Optional: 'general' | 'code' | 'debug'
 * @param {number} options.maxContextChars - Max total chars to include (default 6000)
 * @returns {{ systemPrompt, userPrompt, sources, contextTokenEstimate }}
 */
export function buildContext(rankedChunks, question, options = {}) {
  const {
    persona = 'general',
    maxContextChars = 6000,
  } = options;

  // ── Trim chunks to fit context window ────────────────────────────────────
  const fittedChunks = fitToContextBudget(rankedChunks, maxContextChars);

  // ── Format each source block ──────────────────────────────────────────────
  const sourceBlocks = fittedChunks.map((chunk, i) => {
    const label = formatSourceLabel(chunk, i + 1);
    const text = chunk.text.trim();
    return `${label}\n${text}`;
  });

  const contextSection = sourceBlocks.join('\n\n---\n\n');

  // ── System prompt — varies by persona ────────────────────────────────────
  const systemPrompt = buildSystemPrompt(persona);

  // ── User prompt ───────────────────────────────────────────────────────────
  const userPrompt = `## KNOWLEDGE BASE CONTEXT

${contextSection}

---

## QUESTION

${question}

## INSTRUCTIONS

1. Answer based ONLY on the context above
2. Cite sources inline using [Source N] notation
3. If context is insufficient, say so — never hallucinate
4. End your answer with a "## Sources Used" section listing every [Source N] you cited
5. Be specific and actionable`;

  // ── Source metadata for the API response ─────────────────────────────────
  const sources = fittedChunks.map((chunk, i) => ({
    index:       i + 1,
    id:          chunk.id,
    source:      chunk.source,
    excerpt:     chunk.text.slice(0, 250),
    fileName:    chunk.fileName   || null,
    senderName:  chunk.senderName || null,
    timestamp:   chunk.timestamp  || null,
    score:       chunk.score,
    retrievalMethod: chunk.retrievalMethod || 'vector',
  }));

  const contextTokenEstimate = Math.ceil(
    (systemPrompt.length + userPrompt.length) / 4,
  );

  return { systemPrompt, userPrompt, sources, contextTokenEstimate };
}

// ── System prompts by persona ─────────────────────────────────────────────────
function buildSystemPrompt(persona) {
  const base = `You are SoumyaOps AI — an intelligent assistant embedded in a developer team's platform.
You have access to the team's accumulated knowledge: Telegram messages, documents, code, and past discussions.
You answer questions with precision, citing sources for every claim.
You NEVER make up information that isn't in the provided context.`;

  const personas = {
    general: `${base}
Tone: Clear, concise, helpful. Use markdown for code blocks and lists.`,

    code: `${base}
You specialize in code analysis, debugging, and software architecture.
Always wrap code examples in fenced code blocks with the language tag.
Prefer concrete examples over abstract descriptions.`,

    debug: `${base}
You specialize in error analysis and debugging.
Structure your answers as: (1) Root Cause, (2) Fix, (3) Prevention.
Always reference specific file paths and line numbers when available.`,
  };

  return personas[persona] || personas.general;
}

// ── Helpers ───────────────────────────────────────────────────────────────────
/**
 * Fit chunks into a character budget — trim long chunks rather than drop them
 */
function fitToContextBudget(chunks, maxChars) {
  const fitted = [];
  let used = 0;
  const perChunkMax = Math.floor(maxChars / Math.max(chunks.length, 1));

  for (const chunk of chunks) {
    if (used >= maxChars) break;

    const text = chunk.text?.trim() || '';
    if (!text) continue;

    const allowedChars = Math.min(perChunkMax, maxChars - used, 1500);
    const trimmedText = text.length > allowedChars
      ? text.slice(0, allowedChars) + ' [...]'
      : text;

    fitted.push({ ...chunk, text: trimmedText });
    used += trimmedText.length;
  }

  return fitted;
}

/**
 * Build a readable source label for a chunk
 */
function formatSourceLabel(chunk, index) {
  const parts = [`[Source ${index}]`];

  // Source type badge
  const sourceEmoji = {
    telegram:  '📨 Telegram',
    code:      '💻 Code',
    logs:      '📋 Log',
    document:  '📄 Document',
    manual:    '✏️ Manual',
  };
  parts.push(sourceEmoji[chunk.source] || '📁 ' + (chunk.source || 'Unknown'));

  // Sender (Telegram messages)
  if (chunk.senderName) parts.push(`from ${chunk.senderName}`);

  // File name (code / documents)
  if (chunk.fileName) {
    const shortName = chunk.fileName.length > 50
      ? '...' + chunk.fileName.slice(-47)
      : chunk.fileName;
    parts.push(`(${shortName})`);
  }

  // Timestamp
  if (chunk.timestamp) {
    const d = new Date(chunk.timestamp);
    if (!isNaN(d.getTime())) {
      parts.push(`· ${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`);
    }
  }

  // Relevance score
  if (typeof chunk.score === 'number') {
    parts.push(`· score: ${chunk.score.toFixed(3)}`);
  }

  return parts.join(' ');
}

/**
 * Build a compact context string for use in fix-generation (not RAG Q&A)
 * Shorter format, no markdown headers
 */
export function buildCompactContext(rankedChunks, maxChars = 3000) {
  const fitted = fitToContextBudget(rankedChunks, maxChars);
  return fitted.map((c, i) => {
    const label = `[${i + 1}] ${c.source}${c.fileName ? ` (${c.fileName})` : ''}`;
    return `${label}:\n${c.text.trim()}`;
  }).join('\n\n');
}
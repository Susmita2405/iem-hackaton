// src/services/rag/chunker.service.js
// Intelligent chunking — different strategy per content type

import { RecursiveCharacterTextSplitter } from 'langchain/text_splitter';

/**
 * Main chunker — routes to the right strategy based on source type
 * @param {string} content - Raw text content
 * @param {string} source  - 'telegram' | 'code' | 'logs' | 'document'
 * @param {object} meta    - Metadata to attach to each chunk
 * @returns {Array<{pageContent: string, metadata: object}>}
 */
export async function smartChunk(content, source, meta = {}) {
  switch (source) {
    case 'telegram':
      return chunkChat(content, meta);
    case 'code':
      return chunkCode(content, meta);
    case 'logs':
      return chunkLogs(content, meta);
    default:
      return chunkDocument(content, meta);
  }
}

// ── Chat chunking ─────────────────────────────────────────────────────────────
// Chat messages are short — we group them into conversation windows
// rather than splitting them further.
async function chunkChat(content, meta) {
  // For single messages, wrap as-is (they're already atomic units)
  if (content.length < 1200) {
    return [{
      pageContent: content.trim(),
      metadata: {
        ...meta,
        chunkStrategy: 'chat_atomic',
        charCount: content.length,
      },
    }];
  }

  // Longer messages (forwarded articles, etc.) get paragraph splitting
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 100,
    separators: ['\n\n', '\n', '. ', '! ', '? ', ' '],
  });
  const docs = await splitter.createDocuments([content], [meta]);
  return docs.map((d, i) => ({
    ...d,
    metadata: { ...d.metadata, chunkStrategy: 'chat_paragraph', chunkIndex: i },
  }));
}

// ── Code chunking ─────────────────────────────────────────────────────────────
// Split at function/class boundaries — preserve semantic code units
async function chunkCode(content, meta) {
  const ext = meta.fileName?.split('.').pop() || '';
  const lang = detectLanguage(ext);

  // Code-aware separators — split at function/class/method level first
  const codeSeparators = {
    javascript: [
      '\nfunction ', '\nconst ', '\nclass ', '\nasync function ',
      '\nexport default ', '\nexport function ', '\nmodule.exports',
      '\n\n', '\n',
    ],
    python: [
      '\ndef ', '\nclass ', '\nasync def ',
      '\n\n', '\n',
    ],
    default: ['\n\n\n', '\n\n', '\n'],
  };

  const separators = codeSeparators[lang] || codeSeparators.default;

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1200,
    chunkOverlap: 200,
    separators,
  });

  const docs = await splitter.createDocuments([content], [meta]);
  return docs.map((d, i) => ({
    ...d,
    metadata: {
      ...d.metadata,
      chunkStrategy: 'code_semantic',
      language: lang,
      chunkIndex: i,
    },
  }));
}

// ── Log chunking ──────────────────────────────────────────────────────────────
// Logs need to keep stack traces together — split at error boundaries
async function chunkLogs(content, meta) {
  // Each error block starts with a timestamp or ERROR/WARN prefix
  const errorPattern = /(?=\d{4}-\d{2}-\d{2}|\[ERROR\]|\[WARN\]|ERROR:|Error:)/gm;
  const blocks = content.split(errorPattern).filter(b => b.trim());

  const chunks = [];
  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i].trim();
    if (!block) continue;

    // If a single error block is huge, sub-split it
    if (block.length > 1500) {
      const splitter = new RecursiveCharacterTextSplitter({
        chunkSize: 1200,
        chunkOverlap: 150,
        separators: ['\n\t', '\n  ', '\n', ' '],
      });
      const subDocs = await splitter.createDocuments([block], [meta]);
      subDocs.forEach((d, j) => chunks.push({
        ...d,
        metadata: { ...d.metadata, chunkStrategy: 'log_block', blockIndex: i, subIndex: j },
      }));
    } else {
      chunks.push({
        pageContent: block,
        metadata: { ...meta, chunkStrategy: 'log_error_block', blockIndex: i },
      });
    }
  }

  return chunks.length > 0 ? chunks : [{ pageContent: content, metadata: meta }];
}

// ── Document chunking ─────────────────────────────────────────────────────────
// General documents — semantic paragraph-aware splitting
async function chunkDocument(content, meta) {
  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 1000,
    chunkOverlap: 150,
    separators: ['\n## ', '\n### ', '\n\n', '\n', '. ', ' '],
  });
  const docs = await splitter.createDocuments([content], [meta]);
  return docs.map((d, i) => ({
    ...d,
    metadata: { ...d.metadata, chunkStrategy: 'document_semantic', chunkIndex: i },
  }));
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function detectLanguage(ext) {
  const map = {
    js: 'javascript', ts: 'javascript', jsx: 'javascript', tsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript',
    py: 'python', pyw: 'python',
    go: 'go', rs: 'rust', java: 'java', rb: 'ruby', php: 'php',
  };
  return map[ext] || 'default';
}
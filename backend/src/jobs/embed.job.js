// src/jobs/embed.job.js
// Worker: handles all embedding jobs (messages, voice, telegram docs)

import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { smartChunk } from '../services/rag/chunker.service.js';
import { embedAndStore } from '../services/rag/embedder.service.js';
import { transcribeVoice } from '../services/ingestion/whisper.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export const embedWorker = new Worker(
  'embed',
  async (job) => {
    const { type, workspaceId } = job.data;

    // Get workspace namespace
    const { rows: [ws] } = await query(
      `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const namespace = ws?.pinecone_namespace || workspaceId;

    switch (type) {
      case 'message': {
        const { content, source, metadata, messageId } = job.data;
        const chunks = await smartChunk(content, source, metadata);
        const vectorIds = await embedAndStore(chunks, namespace);

        await query(
          `UPDATE messages SET vector_id = $1, embedded_at = NOW() WHERE id = $2`,
          [vectorIds[0] || null, messageId],
        );
        logger.info(`Embedded message ${messageId} → ${vectorIds.length} vectors`);
        break;
      }

      case 'voice': {
        const { messageId, fileId, workspaceId: wsId, senderName, timestamp } = job.data;

        // Get bot token
        const { rows: [workspace] } = await query(
          `SELECT telegram_bot_token, pinecone_namespace FROM workspaces WHERE id = $1`,
          [wsId],
        );

        await job.updateProgress(10);
        const transcript = await transcribeVoice(fileId, workspace.telegram_bot_token);
        await job.updateProgress(60);

        // Update message with transcript
        await query(
          `UPDATE messages SET content = $1, embedded_at = NULL WHERE id = $2`,
          [`[Voice Note] ${transcript}`, messageId],
        );

        // Now embed the transcript
        const chunks = await smartChunk(transcript, 'telegram', {
          source: 'telegram',
          workspaceId: wsId,
          messageId,
          senderName,
          timestamp,
          contentType: 'voice',
        });
        const vectorIds = await embedAndStore(chunks, workspace.pinecone_namespace || wsId);

        await query(
          `UPDATE messages SET vector_id = $1, embedded_at = NOW() WHERE id = $2`,
          [vectorIds[0] || null, messageId],
        );
        await job.updateProgress(100);
        logger.info(`Voice transcribed + embedded: ${messageId}`);
        break;
      }

      case 'document': {
        const { documentId, content, source, fileName, metadata } = job.data;
        const chunks = await smartChunk(content, source, { ...metadata, fileName });
        const vectorIds = await embedAndStore(chunks, namespace);

        await query(
          `UPDATE documents SET vector_ids = $1, chunk_count = $2, embedded_at = NOW() WHERE id = $3`,
          [vectorIds, vectorIds.length, documentId],
        );
        logger.info(`Document ${fileName} → ${vectorIds.length} chunks embedded`);
        break;
      }

      default:
        logger.warn(`Unknown embed job type: ${type}`);
    }
  },
  {
    connection: createRedisConnection(),
    concurrency: 5,
  },
);


// ─────────────────────────────────────────────────────────────────────────────
// src/jobs/repo-analyze.job.js

import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { analyzeRepo, cloneRepo, getRepoTree } from '../services/github/github.service.js';
import { smartChunk } from '../services/rag/chunker.service.js';
import { embedAndStore } from '../services/rag/embedder.service.js';
import { query } from '../config/database.js';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

export const repoAnalyzeWorker = new Worker(
  'repo-analyze',
  async (job) => {
    const { repoId, workspaceId, userId } = job.data;

    const { rows: [repo] } = await query(`SELECT * FROM repositories WHERE id = $1`, [repoId]);
    const { rows: [user] } = await query(`SELECT github_token FROM users WHERE id = $1`, [userId]);
    const { rows: [ws] }   = await query(`SELECT pinecone_namespace FROM workspaces WHERE id = $1`, [workspaceId]);

    const [owner, repoName] = repo.repo_full_name.split('/');
    const namespace = ws?.pinecone_namespace || workspaceId;

    await job.updateProgress(5);

    // Analyze structure
    const analysis = await analyzeRepo(owner, repoName, user.github_token);

    await query(
      `UPDATE repositories SET detected_type = $1, detected_stack = $2, last_analyzed = NOW() WHERE id = $3`,
      [analysis.type, JSON.stringify(analysis), repoId],
    );

    await job.updateProgress(20);

    // Clone repo
    const localPath = await cloneRepo(repo.repo_url, user.github_token);

    await job.updateProgress(40);

    // Read and embed code files
    const CODE_EXTENSIONS = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php', '.md'];
    const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', 'venv'];

    async function walkDir(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      const results = [];
      for (const entry of entries) {
        if (SKIP_DIRS.some(s => entry.name === s)) continue;
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...await walkDir(fullPath));
        } else if (CODE_EXTENSIONS.some(ext => entry.name.endsWith(ext))) {
          results.push(fullPath);
        }
      }
      return results;
    }

    const files = await walkDir(localPath);
    let processed = 0;

    for (const filePath of files) {
      try {
        const content = await fs.readFile(filePath, 'utf-8');
        const relPath = filePath.replace(localPath + '/', '');
        const ext = path.extname(filePath).slice(1);

        const chunks = await smartChunk(content, 'code', {
          source: 'code',
          workspaceId,
          documentId: `${repoId}_${relPath}`,
          fileName: relPath,
          repoId,
          timestamp: new Date().toISOString(),
        });

        await embedAndStore(chunks, namespace);
        processed++;
        await job.updateProgress(40 + Math.floor((processed / files.length) * 55));
      } catch { /* skip unreadable files */ }
    }

    // Store local path + vector count
    await query(
      `UPDATE repositories SET local_path = $1 WHERE id = $2`,
      [localPath, repoId],
    );

    await job.updateProgress(100);
    logger.info(`Repo ${repo.repo_full_name}: ${files.length} files, ${processed} embedded`);
  },
  { connection: createRedisConnection(), concurrency: 2 },
);


// ─────────────────────────────────────────────────────────────────────────────
// src/jobs/deploy.job.js

import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { orchestrateDeploy } from '../services/deploy/deploy.service.js';
import logger from '../utils/logger.js';

export const deployWorker = new Worker(
  'deploy',
  async (job) => {
    const { deploymentId, repoId, workspaceId, envVars, userId } = job.data;
    await job.updateProgress(5);
    const result = await orchestrateDeploy({ deploymentId, repoId, workspaceId, envVars, userId });
    await job.updateProgress(100);
    return result;
  },
  { connection: createRedisConnection(), concurrency: 3 },
);


// ─────────────────────────────────────────────────────────────────────────────
// src/jobs/log-process.job.js

import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { parseAndStoreErrors } from '../services/debug/debug.service.js';
import logger from '../utils/logger.js';

export const logProcessWorker = new Worker(
  'log-process',
  async (job) => {
    const { rawLog, workspaceId, repoId } = job.data;
    const errors = await parseAndStoreErrors(rawLog, workspaceId, repoId);
    logger.info(`Log processed: ${errors.length} errors detected`);
    return { errorsFound: errors.length, errors };
  },
  { connection: createRedisConnection(), concurrency: 5 },
);


// ─────────────────────────────────────────────────────────────────────────────
// src/jobs/fix-generate.job.js

import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { generateFix } from '../services/debug/debug.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export const fixGenerateWorker = new Worker(
  'fix-generate',
  async (job) => {
    const { logEntryId, workspaceId, userId } = job.data;

    const { rows: [ws] } = await query(
      `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const namespace = ws?.pinecone_namespace || workspaceId;

    await job.updateProgress(10);
    const fix = await generateFix({ logEntryId, workspaceId, namespace, userId });
    await job.updateProgress(100);

    logger.info(`Fix generated for log entry ${logEntryId}`);
    return fix;
  },
  { connection: createRedisConnection(), concurrency: 3 },
);
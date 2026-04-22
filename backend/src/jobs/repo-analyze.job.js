// src/jobs/repo-analyze.job.js
import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { analyzeRepo } from '../services/github/repo-analyzer.service.js';
import { cloneRepo } from '../services/github/github.service.js';
import { smartChunk } from '../services/rag/chunker.service.js';
import { embedAndStore } from '../services/rag/embedder.service.js';
import { query } from '../config/database.js';
import fs from 'fs/promises';
import path from 'path';
import logger from '../utils/logger.js';

const CODE_EXTENSIONS = new Set([
  '.js', '.ts', '.jsx', '.tsx', '.mjs', '.cjs',
  '.py', '.go', '.java', '.rb', '.php', '.rs',
  '.md', '.mdx', '.txt', '.env.example', '.json',
]);

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next',
  '__pycache__', 'venv', '.venv', 'vendor', 'coverage',
  '.nyc_output', 'out', '.turbo',
]);

export const repoAnalyzeWorker = new Worker(
  'repo-analyze',
  async (job) => {
    const { repoId, workspaceId, userId } = job.data;

    const { rows: [repo] }  = await query(`SELECT * FROM repositories WHERE id = $1`, [repoId]);
    const { rows: [user] }  = await query(`SELECT github_token FROM users WHERE id = $1`, [userId]);
    const { rows: [ws] }    = await query(`SELECT pinecone_namespace FROM workspaces WHERE id = $1`, [workspaceId]);

    const [owner, repoName] = repo.repo_full_name.split('/');
    const namespace = ws?.pinecone_namespace || workspaceId;

    logger.info(`[repo-analyze] Analyzing ${repo.repo_full_name}`);
    await job.updateProgress(5);

    // ── Step 1: Structural analysis ─────────────────────────────────────────
    const analysis = await analyzeRepo(owner, repoName, user.github_token);

    await query(
      `UPDATE repositories
       SET detected_type = $1, detected_stack = $2, last_analyzed = NOW()
       WHERE id = $3`,
      [analysis.type, JSON.stringify(analysis), repoId],
    );

    await job.updateProgress(15);

    // ── Step 2: Clone repo ───────────────────────────────────────────────────
    let localPath;
    try {
      localPath = await cloneRepo(repo.repo_url, user.github_token);
    } catch (err) {
      logger.error(`[repo-analyze] Clone failed for ${repo.repo_full_name}: ${err.message}`);
      throw err;
    }

    await job.updateProgress(30);

    // ── Step 3: Walk and collect embeddable files ────────────────────────────
    async function walkDir(dir, collected = []) {
      let entries;
      try { entries = await fs.readdir(dir, { withFileTypes: true }); }
      catch { return collected; }

      for (const entry of entries) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          await walkDir(fullPath, collected);
        } else {
          const ext = path.extname(entry.name).toLowerCase();
          if (CODE_EXTENSIONS.has(ext)) collected.push(fullPath);
        }
      }
      return collected;
    }

    const files = await walkDir(localPath);
    logger.info(`[repo-analyze] Found ${files.length} files to embed`);

    await job.updateProgress(35);

    // ── Step 4: Embed files in batches ───────────────────────────────────────
    let processed = 0;
    const BATCH = 10;

    for (let i = 0; i < files.length; i += BATCH) {
      const batch = files.slice(i, i + BATCH);

      await Promise.allSettled(batch.map(async (filePath) => {
        try {
          const content = await fs.readFile(filePath, 'utf-8');
          if (!content.trim() || content.length > 100_000) return; // skip empty/huge files

          const relPath = filePath.replace(localPath + path.sep, '');
          const chunks = await smartChunk(content, 'code', {
            source: 'code',
            workspaceId,
            documentId: `${repoId}:${relPath}`,
            fileName: relPath,
            repoId,
            repoFullName: repo.repo_full_name,
            timestamp: new Date().toISOString(),
          });

          await embedAndStore(chunks, namespace);
          processed++;
        } catch { /* skip unreadable/binary files */ }
      }));

      const progress = 35 + Math.floor(((i + BATCH) / files.length) * 60);
      await job.updateProgress(Math.min(progress, 95));
    }

    // ── Step 5: Store local path ─────────────────────────────────────────────
    await query(
      `UPDATE repositories SET local_path = $1 WHERE id = $2`,
      [localPath, repoId],
    );

    await job.updateProgress(100);
    logger.info(`[repo-analyze] Done: ${repo.repo_full_name} — ${processed}/${files.length} files embedded`);

    return { repoId, filesFound: files.length, filesEmbedded: processed, analysis };
  },
  {
    connection: createRedisConnection(),
    concurrency: 2, // cloning is heavy — keep low
  },
);

repoAnalyzeWorker.on('failed', async (job, err) => {
  logger.error(`[repo-analyze] Failed for repo ${job?.data?.repoId}: ${err.message}`);
});
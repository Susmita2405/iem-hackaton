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

    logger.info(`[fix-generate] Generating fix for log entry ${logEntryId}`);
    await job.updateProgress(10);

    // Get workspace namespace
    const { rows: [ws] } = await query(
      `SELECT pinecone_namespace FROM workspaces WHERE id = $1`,
      [workspaceId],
    );
    const namespace = ws?.pinecone_namespace || workspaceId;

    await job.updateProgress(20);

    const fix = await generateFix({
      logEntryId,
      workspaceId,
      namespace,
      userId,
    });

    await job.updateProgress(100);
    logger.info(`[fix-generate] Fix generated for ${logEntryId}: confidence=${fix.confidence}`);
    return { fixId: fix.fixId, confidence: fix.confidence };
  },
  {
    connection: createRedisConnection(),
    concurrency: 3,
  },
);

fixGenerateWorker.on('failed', async (job, err) => {
  logger.error(`[fix-generate] Failed for log entry ${job?.data?.logEntryId}: ${err.message}`);
  if (job?.data?.logEntryId) {
    await query(
      `UPDATE log_entries SET status = 'open' WHERE id = $1`,
      [job.data.logEntryId],
    ).catch(() => {});
  }
});
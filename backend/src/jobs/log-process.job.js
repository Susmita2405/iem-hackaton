// src/jobs/log-process.job.js
import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { parseAndStoreErrors } from '../services/debug/debug.service.js';
import logger from '../utils/logger.js';

export const logProcessWorker = new Worker(
  'log-process',
  async (job) => {
    const { rawLog, workspaceId, repoId } = job.data;

    logger.info(`[log-process] Processing log chunk (${rawLog.length} chars) for workspace ${workspaceId}`);
    await job.updateProgress(10);

    const errors = await parseAndStoreErrors(rawLog, workspaceId, repoId);

    await job.updateProgress(100);
    logger.info(`[log-process] Detected ${errors.length} error(s)`);

    return {
      errorsFound: errors.length,
      errorIds: errors.map(e => e.id),
      errorTypes: errors.map(e => e.errorType),
    };
  },
  {
    connection: createRedisConnection(),
    concurrency: 5,
  },
);

logProcessWorker.on('failed', (job, err) => {
  logger.error(`[log-process] Job failed: ${err.message}`);
});
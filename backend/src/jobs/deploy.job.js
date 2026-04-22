// src/jobs/deploy.job.js
import { Worker } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import { orchestrateDeploy } from '../services/deploy/deploy.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

export const deployWorker = new Worker(
  'deploy',
  async (job) => {
    const { deploymentId, repoId, workspaceId, envVars, userId, platform } = job.data;

    logger.info(`[deploy-job] Starting deployment ${deploymentId}`);
    await job.updateProgress(5);

    const result = await orchestrateDeploy({
      deploymentId,
      repoId,
      workspaceId,
      envVars,
      userId,
      platform,
    });

    await job.updateProgress(100);
    logger.info(`[deploy-job] Completed: ${deploymentId} → ${result.liveUrl}`);
    return result;
  },
  {
    connection: createRedisConnection(),
    concurrency: 3,
    limiter: { max: 10, duration: 60_000 }, // 10 deploys/min max
  },
);

deployWorker.on('failed', async (job, err) => {
  logger.error(`[deploy-job] Failed ${job?.data?.deploymentId}: ${err.message}`);
  // Deployment status updated inside orchestrateDeploy on error
});
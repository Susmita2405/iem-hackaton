// src/jobs/queue.js
// Central queue setup — all BullMQ queues and worker bootstrapper

import { Queue, Worker, QueueEvents } from 'bullmq';
import { createRedisConnection } from '../config/redis.js';
import logger from '../utils/logger.js';

// ── Queue names ───────────────────────────────────────────────────────────────
export const QUEUES = {
  EMBED:        'embed',
  REPO_ANALYZE: 'repo-analyze',
  DEPLOY:       'deploy',
  LOG_PROCESS:  'log-process',
  FIX_GENERATE: 'fix-generate',
};

// ── Default job options ───────────────────────────────────────────────────────
const defaultJobOptions = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 50 },
};

// ── Queue instances (used to add jobs) ────────────────────────────────────────
export const embedQueue       = new Queue(QUEUES.EMBED,        { connection: createRedisConnection(), defaultJobOptions });
export const repoAnalyzeQueue = new Queue(QUEUES.REPO_ANALYZE, { connection: createRedisConnection(), defaultJobOptions });
export const deployQueue      = new Queue(QUEUES.DEPLOY,       { connection: createRedisConnection(), defaultJobOptions });
export const logProcessQueue  = new Queue(QUEUES.LOG_PROCESS,  { connection: createRedisConnection(), defaultJobOptions });
export const fixGenerateQueue = new Queue(QUEUES.FIX_GENERATE, { connection: createRedisConnection(), defaultJobOptions });

// ── Start all workers ─────────────────────────────────────────────────────────
export async function startWorkers() {
  const { embedWorker }       = await import('./embed.job.js');
  const { repoAnalyzeWorker } = await import('./repo-analyze.job.js');
  const { deployWorker }      = await import('./deploy.job.js');
  const { logProcessWorker }  = await import('./log-process.job.js');
  const { fixGenerateWorker } = await import('./fix-generate.job.js');

  const workers = [embedWorker, repoAnalyzeWorker, deployWorker, logProcessWorker, fixGenerateWorker];

  workers.forEach(worker => {
    worker.on('completed', (job) => {
      logger.info(`[Queue] Job ${job.name}:${job.id} completed`);
    });
    worker.on('failed', (job, err) => {
      logger.error(`[Queue] Job ${job?.name}:${job?.id} failed: ${err.message}`);
    });
  });

  logger.info(`${workers.length} BullMQ workers started`);
  return workers;
}

// ── WebSocket progress broadcaster ────────────────────────────────────────────
export function broadcastJobProgress(app, jobId, data) {
  const wss = app?.get?.('wss');
  if (!wss) return;
  const payload = JSON.stringify({ type: 'job_progress', jobId, ...data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}
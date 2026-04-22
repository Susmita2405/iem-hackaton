// src/config/redis.js
import Redis from 'ioredis';
import logger from '../utils/logger.js';

let redisClient;

export async function connectRedis() {
  redisClient = new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null, // Required for BullMQ
    enableReadyCheck: false,
    retryStrategy: (times) => Math.min(times * 100, 3000),
  });

  redisClient.on('error', (err) => logger.error('Redis error:', err.message));
  redisClient.on('connect', () => logger.info('Redis connected'));

  await redisClient.ping();
  return redisClient;
}

export function getRedis() {
  if (!redisClient) throw new Error('Redis not initialized');
  return redisClient;
}

// Duplicate connection for BullMQ (it needs its own connection)
export function createRedisConnection() {
  return new Redis({
    host: process.env.REDIS_HOST || 'localhost',
    port: Number(process.env.REDIS_PORT) || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  });
}
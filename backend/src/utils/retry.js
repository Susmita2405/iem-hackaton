// src/utils/retry.js
// Exponential backoff retry utility for external API calls

import logger from './logger.js';

/**
 * Retry an async function with exponential backoff
 *
 * @param {Function} fn              - Async function to retry
 * @param {object}   options
 * @param {number}   options.retries   - Max retry attempts (default: 3)
 * @param {number}   options.baseDelay - Initial delay in ms (default: 500)
 * @param {number}   options.maxDelay  - Max delay cap in ms (default: 10000)
 * @param {number}   options.factor    - Backoff multiplier (default: 2)
 * @param {Function} options.shouldRetry - (err) => bool, custom retry condition
 * @param {string}   options.context  - Label for logs
 * @returns {Promise<*>}
 */
export async function retryWithBackoff(fn, options = {}) {
  const {
    retries    = 3,
    baseDelay  = 500,
    maxDelay   = 10_000,
    factor     = 2,
    shouldRetry = defaultShouldRetry,
    context    = 'operation',
  } = options;

  let lastError;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;

      // Last attempt — don't retry
      if (attempt === retries) break;

      // Check if this error type is retryable
      if (!shouldRetry(err)) {
        logger.warn(`[retry] Non-retryable error in ${context}: ${err.message}`);
        throw err;
      }

      // Calculate delay with jitter
      const baseWait = Math.min(baseDelay * Math.pow(factor, attempt), maxDelay);
      const jitter   = Math.random() * baseWait * 0.2; // ±20% jitter
      const delay    = Math.floor(baseWait + jitter);

      logger.warn(
        `[retry] ${context} failed (attempt ${attempt + 1}/${retries + 1}), ` +
        `retrying in ${delay}ms: ${err.message}`,
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

/**
 * Default retry condition — retries on network errors and 5xx responses
 */
function defaultShouldRetry(err) {
  // Network / timeout errors
  if (err.code === 'ECONNRESET' || err.code === 'ENOTFOUND' ||
      err.code === 'ETIMEDOUT'  || err.code === 'ECONNREFUSED') {
    return true;
  }

  // Axios HTTP errors
  const status = err.response?.status;
  if (status) {
    // Retry on: 429 (rate limit), 502, 503, 504
    return status === 429 || status >= 502;
  }

  // Unknown errors — retry
  return true;
}

/**
 * Retry with a fixed delay (no exponential backoff)
 */
export async function retryFixed(fn, { retries = 3, delay = 1000, context = 'operation' } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (attempt < retries) {
        logger.warn(`[retry] ${context} attempt ${attempt + 1} failed, retrying in ${delay}ms`);
        await sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Retry with a custom condition that checks the result (not just errors)
 * Useful for polling APIs where success is a specific response state
 */
export async function pollUntil(fn, {
  condition,
  maxAttempts = 20,
  interval    = 3000,
  context     = 'poll',
} = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await fn();
    if (condition(result)) return result;

    if (attempt < maxAttempts - 1) {
      logger.debug(`[retry] ${context} polling (attempt ${attempt + 1}/${maxAttempts})`);
      await sleep(interval);
    }
  }
  throw new Error(`[retry] ${context} did not reach desired state after ${maxAttempts} attempts`);
}

/**
 * Simple promise-based sleep
 */
export function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run promises with a concurrency limit
 */
export async function pLimit(tasks, limit = 5) {
  const results = [];
  const executing = [];

  for (const task of tasks) {
    const p = Promise.resolve().then(task);
    results.push(p);

    if (limit <= tasks.length) {
      const e = p.then(() => executing.splice(executing.indexOf(e), 1));
      executing.push(e);
      if (executing.length >= limit) {
        await Promise.race(executing);
      }
    }
  }

  return Promise.all(results);
}
// src/middleware/rateLimit.middleware.js
import rateLimit from 'express-rate-limit';

/**
 * General API rate limiter — 200 req / 15 min per IP
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' },
  skip: (req) => process.env.NODE_ENV === 'test',
});

/**
 * Strict limiter for auth endpoints — 20 req / 15 min per IP
 * Prevents brute-force OAuth attempts
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later.' },
});

/**
 * RAG query limiter — 60 req / min per IP
 * Each query hits Pinecone + Claude — protect costs
 */
export const ragLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many RAG queries, slow down.' },
});

/**
 * Deploy limiter — 10 deployments / 10 min per IP
 */
export const deployLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many deployment requests.' },
});

/**
 * Ingest limiter — 30 uploads / 5 min per IP
 */
export const ingestLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many ingestion requests.' },
});

/**
 * Webhook limiter — relaxed, Telegram may send bursts
 */
export const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
});
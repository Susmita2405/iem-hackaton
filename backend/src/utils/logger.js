// src/utils/logger.js
import { createLogger, format, transports } from 'winston';
import { maskSecrets } from './secretMask.js';

const { combine, timestamp, printf, colorize, errors } = format;

// Custom format that masks secrets before logging
const safeFormat = printf(({ level, message, timestamp, stack, ...meta }) => {
  const safeMessage = typeof message === 'string' ? maskSecrets(message) : message;
  const metaStr = Object.keys(meta).length ? JSON.stringify(meta) : '';
  return `${timestamp} [${level}] ${safeMessage}${stack ? '\n' + stack : ''}${metaStr ? ' ' + metaStr : ''}`;
});

const logger = createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: combine(
    errors({ stack: true }),
    timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
    safeFormat,
  ),
  transports: [
    new transports.Console({
      format: combine(colorize(), timestamp({ format: 'HH:mm:ss' }), safeFormat),
    }),
    new transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 5 * 1024 * 1024,
      maxFiles: 5,
    }),
    new transports.File({
      filename: 'logs/combined.log',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 5,
    }),
  ],
});

export default logger;
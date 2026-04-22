// src/middleware/error.middleware.js
import logger from '../utils/logger.js';

/**
 * Global Express error handler
 * Must have 4 parameters for Express to recognize as error handler
 */
export function errorMiddleware(err, req, res, next) {
  // Log the error internally
  logger.error('Unhandled error', {
    method: req.method,
    url: req.originalUrl,
    message: err.message,
    stack: process.env.NODE_ENV !== 'production' ? err.stack?.slice(0, 800) : undefined,
  });

  // Determine status code
  const status = err.status || err.statusCode || err.code === 'ENOENT' ? 404 : 500;

  // In production, hide internal error details for 5xx
  const message = (process.env.NODE_ENV === 'production' && status >= 500)
    ? 'Internal server error'
    : err.message || 'Something went wrong';

  // Handle common known errors
  if (err.code === '23505') {
    // PostgreSQL unique constraint violation
    return res.status(409).json({ error: 'Resource already exists', detail: err.detail });
  }
  if (err.code === '23503') {
    // PostgreSQL foreign key violation
    return res.status(400).json({ error: 'Referenced resource not found' });
  }
  if (err.name === 'ValidationError') {
    return res.status(422).json({ error: 'Validation failed', details: err.details });
  }

  res.status(typeof status === 'number' ? status : 500).json({ error: message });
}

/**
 * Wrap async route handlers to auto-catch thrown errors
 * Usage: router.get('/path', asyncHandler(myController))
 */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * 404 handler — attach AFTER all routes
 */
export function notFoundHandler(req, res) {
  res.status(404).json({
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
}
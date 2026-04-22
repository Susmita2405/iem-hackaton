// src/middleware/secretDetect.middleware.js
import { maskSecrets, containsSecret } from '../utils/secretMask.js';
import logger from '../utils/logger.js';

/**
 * Masks secrets found in request bodies before they reach controllers or logs.
 * Also warns if a secret-looking value is detected in an unexpected field.
 */
export function secretDetectMiddleware(req, res, next) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req.body = deepMask(req.body, req);
  }
  next();
}

function deepMask(obj, req, path = '') {
  if (typeof obj === 'string') {
    if (containsSecret(obj)) {
      // Only warn for unexpected fields (not known-secret fields like botToken)
      const knownSecretFields = ['botToken', 'token', 'apiKey', 'password', 'secret', 'githubToken'];
      const fieldName = path.split('.').pop();
      if (!knownSecretFields.some(f => fieldName?.toLowerCase().includes(f.toLowerCase()))) {
        logger.warn(`Potential secret detected in request field: ${path} (${req.method} ${req.originalUrl})`);
      }
    }
    return maskSecrets(obj);
  }

  if (Array.isArray(obj)) {
    return obj.map((item, i) => deepMask(item, req, `${path}[${i}]`));
  }

  if (obj !== null && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = deepMask(value, req, path ? `${path}.${key}` : key);
    }
    return result;
  }

  return obj;
}

/**
 * Response interceptor — strip secrets from outgoing JSON responses.
 * Useful as a safety net to prevent accidental secret leakage in API responses.
 */
export function secretScrubResponse(req, res, next) {
  const originalJson = res.json.bind(res);
  res.json = (data) => {
    const scrubbed = deepMask(data, req, 'response');
    return originalJson(scrubbed);
  };
  next();
}
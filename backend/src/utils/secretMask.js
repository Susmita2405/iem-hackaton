// src/utils/secretMask.js
// Regex-based secret detection and masking
// Applied to: request bodies, log output, DB content, API responses

// ── Secret patterns ───────────────────────────────────────────────────────────
const SECRET_PATTERNS = [
  // GitHub tokens
  { regex: /ghp_[a-zA-Z0-9]{36}/g,                                  name: 'github-pat' },
  { regex: /github_pat_[a-zA-Z0-9_]{82}/g,                           name: 'github-pat-fine' },
  { regex: /ghs_[a-zA-Z0-9]{36}/g,                                   name: 'github-server-to-server' },
  { regex: /ghr_[a-zA-Z0-9]{36}/g,                                   name: 'github-refresh' },

  // OpenAI / Anthropic
  { regex: /sk-ant-api\d{2}-[a-zA-Z0-9\-_]{93}AA/g,                 name: 'anthropic-key' },
  { regex: /sk-[a-zA-Z0-9]{48}/g,                                    name: 'openai-key' },
  { regex: /sk-proj-[a-zA-Z0-9\-_]{100,}/g,                         name: 'openai-project-key' },

  // AWS
  { regex: /AKIA[0-9A-Z]{16}/g,                                      name: 'aws-access-key' },
  { regex: /(?<=aws_secret_access_key\s*=\s*)[A-Za-z0-9/+=]{40}/gi, name: 'aws-secret-key' },

  // Stripe
  { regex: /sk_live_[0-9a-zA-Z]{24}/g,                               name: 'stripe-live-key' },
  { regex: /sk_test_[0-9a-zA-Z]{24}/g,                               name: 'stripe-test-key' },
  { regex: /rk_live_[0-9a-zA-Z]{24}/g,                               name: 'stripe-restricted-key' },

  // Telegram bot tokens
  { regex: /\d{8,12}:AA[a-zA-Z0-9\-_]{33}/g,                        name: 'telegram-bot-token' },

  // JWT tokens (3-part base64url)
  { regex: /eyJ[a-zA-Z0-9\-_]+\.eyJ[a-zA-Z0-9\-_]+\.[a-zA-Z0-9\-_]+/g, name: 'jwt' },

  // Generic Bearer tokens in headers/values
  { regex: /Bearer\s+([a-zA-Z0-9\-_.~+/]+=*)/g,                     name: 'bearer-token', valueGroup: 1 },

  // Generic API keys in key=value / key: value format
  {
    regex: /\b(api[_-]?key|apikey|access[_-]?token|auth[_-]?token|secret[_-]?key|private[_-]?key|client[_-]?secret)\s*[=:]\s*["']?([a-zA-Z0-9\-_.~+/]{20,})["']?/gi,
    name: 'generic-key-value',
    valueGroup: 2,
  },

  // Passwords in connection strings
  {
    regex: /(:\/\/[^:]+:)([^@]{8,})(@)/g,
    name: 'connection-string-password',
    valueGroup: 2,
  },

  // High-entropy hex strings (32–64 hex chars) — likely tokens/hashes
  { regex: /\b[a-f0-9]{32,64}\b/g,                                   name: 'hex-secret' },

  // Pinecone
  { regex: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, name: 'uuid-token' },
];

// Fields that are always secret regardless of content
const ALWAYS_SECRET_FIELD_NAMES = new Set([
  'password', 'passwd', 'pwd', 'secret', 'token', 'apikey', 'api_key',
  'access_token', 'refresh_token', 'private_key', 'client_secret',
  'auth_token', 'authorization', 'x-api-key', 'x-auth-token',
  'github_token', 'bot_token', 'bottoken', 'telegram_bot_token',
  'stripe_secret_key', 'anthropic_api_key', 'openai_api_key',
  'pinecone_api_key', 'vercel_token', 'railway_token',
]);

/**
 * Mask secrets in a string
 * @param {string} text
 * @returns {string}
 */
export function maskSecrets(text) {
  if (typeof text !== 'string' || !text) return text;

  let masked = text;

  for (const { regex, valueGroup } of SECRET_PATTERNS) {
    // Reset lastIndex for global regexes
    regex.lastIndex = 0;

    if (valueGroup) {
      // Only mask the captured group, not the whole match
      masked = masked.replace(regex, (match, ...groups) => {
        const value = groups[valueGroup - 1];
        if (!value || value.length < 8) return match;
        return match.replace(value, maskValue(value));
      });
    } else {
      masked = masked.replace(regex, (match) => {
        if (match.length < 8) return match;
        return maskValue(match);
      });
    }

    regex.lastIndex = 0; // Reset after use
  }

  return masked;
}

/**
 * Check if a string contains any secret pattern
 * @param {string} text
 * @returns {boolean}
 */
export function containsSecret(text) {
  if (typeof text !== 'string' || !text) return false;

  for (const { regex } of SECRET_PATTERNS) {
    regex.lastIndex = 0;
    if (regex.test(text)) {
      regex.lastIndex = 0;
      return true;
    }
    regex.lastIndex = 0;
  }
  return false;
}

/**
 * Check if an object key is a known secret field
 * @param {string} fieldName
 * @returns {boolean}
 */
export function isSecretField(fieldName) {
  const lower = fieldName.toLowerCase().replace(/[-\s]/g, '_');
  return ALWAYS_SECRET_FIELD_NAMES.has(lower);
}

/**
 * Deep-mask secrets in an object (for logging)
 * @param {*} obj
 * @returns {*}
 */
export function deepMaskObject(obj) {
  if (typeof obj === 'string') return maskSecrets(obj);
  if (typeof obj === 'number' || typeof obj === 'boolean' || obj === null) return obj;

  if (Array.isArray(obj)) {
    return obj.map(item => deepMaskObject(item));
  }

  if (typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      if (isSecretField(key)) {
        result[key] = typeof value === 'string' ? maskValue(value) : '***MASKED***';
      } else {
        result[key] = deepMaskObject(value);
      }
    }
    return result;
  }

  return obj;
}

/**
 * Sanitize env vars object for logging — masks all values
 * @param {object} envVars - { KEY: 'value' }
 * @returns {object}
 */
export function maskEnvVars(envVars) {
  if (!envVars || typeof envVars !== 'object') return envVars;
  const result = {};
  for (const [key, value] of Object.entries(envVars)) {
    result[key] = typeof value === 'string' && value.length > 0
      ? maskValue(value)
      : value;
  }
  return result;
}

// ── Internal helpers ──────────────────────────────────────────────────────────
function maskValue(value) {
  if (!value || value.length < 4) return '***';
  // Show first 3 chars + asterisks + last 2 chars for identification
  const prefix = value.slice(0, Math.min(3, Math.floor(value.length * 0.2)));
  const suffix = value.length > 8 ? value.slice(-2) : '';
  const asterisks = '*'.repeat(Math.min(8, value.length - prefix.length - suffix.length));
  return `${prefix}${asterisks}${suffix}`;
}
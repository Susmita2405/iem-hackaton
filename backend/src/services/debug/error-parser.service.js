// src/services/debug/error-parser.service.js
// Parses raw log text into structured error objects

/**
 * Main entry point — parse a raw log string into an array of structured errors
 * @param {string} rawLog
 * @returns {Array<StructuredError>}
 */
export function parseErrors(rawLog) {
  if (!rawLog?.trim()) return [];

  const errors = [];
  const lines = rawLog.split('\n');

  let currentError = null;
  let stackLines = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const matched = tryMatchErrorLine(line, i + 1);

    if (matched) {
      // Flush previous error
      if (currentError) {
        currentError.stackTrace = stackLines.join('\n').trim();
        errors.push(currentError);
        stackLines = [];
      }
      currentError = matched;
    } else if (currentError && isStackLine(line)) {
      stackLines.push(line);
    } else if (currentError && line.trim() === '' && stackLines.length > 0) {
      // Blank line after stack = end of this error block
      currentError.stackTrace = stackLines.join('\n').trim();
      errors.push(currentError);
      currentError = null;
      stackLines = [];
    }
  }

  // Flush final error
  if (currentError) {
    currentError.stackTrace = stackLines.join('\n').trim();
    errors.push(currentError);
  }

  // Deduplicate by message + type
  return deduplicate(errors);
}

// ── Patterns ──────────────────────────────────────────────────────────────────
const ERROR_PATTERNS = [
  // ISO timestamp + ERROR: message
  {
    regex: /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)\s+\[?(ERROR|FATAL|CRITICAL)\]?\s*[:\-]?\s*(.+)/i,
    level: 'ERROR',
    messageGroup: 3,
    timestampGroup: 1,
  },
  // [ERROR] message or ERROR: message (without timestamp)
  {
    regex: /^\[?(ERROR|FATAL|CRITICAL)\]?\s*[:\-]\s*(.+)/i,
    level: 'ERROR',
    messageGroup: 2,
  },
  // Python/JS exception class: message
  {
    regex: /^([A-Z][a-zA-Z]+(?:Error|Exception|Fault|Warning))\s*:\s*(.+)/,
    level: 'ERROR',
    typeGroup: 1,
    messageGroup: 2,
  },
  // Uncaught exception
  {
    regex: /^Uncaught\s+([A-Z][a-zA-Z]+(?:Error|Exception))\s*:\s*(.+)/,
    level: 'ERROR',
    typeGroup: 1,
    messageGroup: 2,
  },
  // WARN level
  {
    regex: /^(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}[^\s]*)?\s*\[?(WARN|WARNING)\]?\s*[:\-]?\s*(.+)/i,
    level: 'WARN',
    messageGroup: 3,
  },
  // Generic: throw new Error('...') style in output
  {
    regex: /^Error:\s*(.+)/,
    level: 'ERROR',
    messageGroup: 1,
  },
  // Java-style exception
  {
    regex: /^(?:java\.[\w.]+|com\.[\w.]+|org\.[\w.]+)\s*:\s*(.+)/,
    level: 'ERROR',
    messageGroup: 1,
  },
];

function tryMatchErrorLine(line, lineNumber) {
  const trimmed = line.trim();
  if (!trimmed) return null;

  for (const pattern of ERROR_PATTERNS) {
    const m = trimmed.match(pattern.regex);
    if (!m) continue;

    const message = m[pattern.messageGroup]?.trim();
    if (!message || message.length < 3) continue;

    const errorType = pattern.typeGroup
      ? m[pattern.typeGroup]
      : extractErrorType(message);

    // Extract file location from message if present
    const location = extractLocation(message);

    return {
      level: pattern.level || 'ERROR',
      errorType,
      message: message.slice(0, 512),
      stackTrace: '',
      filePath: location?.filePath || null,
      lineNumber: location?.lineNumber || null,
      timestamp: pattern.timestampGroup ? m[pattern.timestampGroup] : null,
      rawLine: line,
      originalLineNumber: lineNumber,
      metadata: {},
    };
  }

  return null;
}

function isStackLine(line) {
  const t = line.trim();
  return (
    t.startsWith('at ') ||
    t.startsWith('\tat ') ||
    t.startsWith('  at ') ||
    t.startsWith('File "') ||      // Python
    t.match(/^\s+at .+\(.+:\d+:\d+\)/) !== null ||
    t.match(/^\s+File ".+", line \d+/) !== null
  );
}

function extractErrorType(message) {
  // Try to find a capitalized Error/Exception class name in the message
  const m = message.match(/([A-Z][a-zA-Z]+(?:Error|Exception|Fault))/);
  return m ? m[1] : 'UnknownError';
}

function extractLocation(message) {
  // JS: at Object.<anonymous> (/path/to/file.js:42:10)
  const jsMatch = message.match(/\((.+\.(?:js|ts|jsx|tsx|mjs)):(\d+)(?::\d+)?\)/);
  if (jsMatch) return { filePath: jsMatch[1], lineNumber: parseInt(jsMatch[2]) };

  // Python: File "/path/to/file.py", line 42
  const pyMatch = message.match(/File "(.+\.py)", line (\d+)/);
  if (pyMatch) return { filePath: pyMatch[1], lineNumber: parseInt(pyMatch[2]) };

  // Generic: path:line
  const genericMatch = message.match(/([/\\][\w/\\.-]+\.\w+):(\d+)/);
  if (genericMatch) return { filePath: genericMatch[1], lineNumber: parseInt(genericMatch[2]) };

  return null;
}

function deduplicate(errors) {
  const seen = new Set();
  return errors.filter(err => {
    const key = `${err.errorType}:${err.message.slice(0, 80)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
// src/services/deploy/env-detector.service.js
// Detects required environment variables from a repository

import { getFileContent } from '../github/github.service.js';

/**
 * Detect required ENV vars for a repo
 * Checks: .env.example, .env.sample, .env.template, source code patterns
 * @param {string} repoFullName  - "owner/repo"
 * @param {string} githubToken
 * @returns {Array<{ key, hasDefault, defaultValue, required, description }>}
 */
export async function detectEnvVars(repoFullName, githubToken) {
  const [owner, repo] = repoFullName.split('/');
  const allVars = new Map();

  // ── Check .env.* example files ────────────────────────────────────────────
  const envFiles = ['.env.example', '.env.sample', '.env.template', '.env.defaults', '.env'];
  for (const fileName of envFiles) {
    const content = await getFileContent(owner, repo, fileName, githubToken).catch(() => null);
    if (content) {
      const parsed = parseEnvFile(content, fileName);
      for (const v of parsed) {
        if (!allVars.has(v.key)) allVars.set(v.key, v);
      }
      break; // Use first found
    }
  }

  // ── Scan source files for process.env.SOME_VAR patterns ──────────────────
  const sourceFiles = [
    'src/config/index.js', 'src/config/config.js', 'config/index.js',
    'src/index.js', 'index.js', 'src/app.js', 'app.js',
    'src/config/index.ts', 'config.ts', 'config.js',
  ];

  for (const file of sourceFiles) {
    const content = await getFileContent(owner, repo, file, githubToken).catch(() => null);
    if (!content) continue;

    const found = extractProcessEnvRefs(content);
    for (const key of found) {
      if (!allVars.has(key)) {
        allVars.set(key, {
          key,
          hasDefault: false,
          defaultValue: null,
          required: true,
          description: null,
          source: file,
        });
      }
    }
  }

  // ── Detect common vars by framework ──────────────────────────────────────
  const pkgJson = await getFileContent(owner, repo, 'package.json', githubToken).catch(() => null);
  if (pkgJson) {
    const frameworkVars = detectFrameworkVars(pkgJson);
    for (const v of frameworkVars) {
      if (!allVars.has(v.key)) allVars.set(v.key, v);
    }
  }

  return Array.from(allVars.values());
}

// ── Parse a .env.example file ─────────────────────────────────────────────────
function parseEnvFile(content, sourceName) {
  const vars = [];
  const lines = content.split('\n');
  let lastComment = null;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('#')) {
      lastComment = trimmed.slice(1).trim();
      continue;
    }

    if (!trimmed || !trimmed.includes('=')) {
      lastComment = null;
      continue;
    }

    const eqIdx = trimmed.indexOf('=');
    const key = trimmed.slice(0, eqIdx).trim();
    const rawValue = trimmed.slice(eqIdx + 1).trim();

    if (!key || !/^[A-Z_][A-Z0-9_]*$/i.test(key)) {
      lastComment = null;
      continue;
    }

    // Determine if it has a real default (not a placeholder)
    const isPlaceholder = /^(your_|<|YOUR_|REPLACE_|CHANGE_|xxx|TODO)/i.test(rawValue);
    const hasDefault = rawValue !== '' && !isPlaceholder;

    vars.push({
      key,
      hasDefault,
      defaultValue: hasDefault ? rawValue.replace(/^["']|["']$/g, '') : null,
      required: !hasDefault,
      description: lastComment || null,
      source: sourceName,
    });

    lastComment = null;
  }

  return vars;
}

// ── Extract process.env.VAR_NAME references from JS/TS source ─────────────────
function extractProcessEnvRefs(content) {
  const found = new Set();
  const patterns = [
    /process\.env\.([A-Z_][A-Z0-9_]+)/g,
    /process\.env\[['"]([A-Z_][A-Z0-9_]+)['"]\]/g,
    /import\.meta\.env\.([A-Z_][A-Z0-9_]+)/g,  // Vite
    /Deno\.env\.get\(['"]([A-Z_][A-Z0-9_]+)['"]\)/g,  // Deno
  ];

  for (const pattern of patterns) {
    let m;
    while ((m = pattern.exec(content)) !== null) {
      // Skip common non-secret vars
      const skip = new Set(['NODE_ENV', 'PORT', 'HOST', 'PATH', 'HOME', 'USER', 'SHELL']);
      if (!skip.has(m[1])) found.add(m[1]);
    }
  }

  return [...found];
}

// ── Detect vars commonly needed by specific frameworks ─────────────────────────
function detectFrameworkVars(pkgJsonString) {
  const vars = [];
  try {
    const pkg = JSON.parse(pkgJsonString);
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };

    if (deps['@prisma/client']) {
      vars.push({ key: 'DATABASE_URL', hasDefault: false, defaultValue: null, required: true, description: 'Prisma database connection URL' });
    }
    if (deps.mongoose || deps.mongodb) {
      vars.push({ key: 'MONGODB_URI', hasDefault: false, defaultValue: null, required: true, description: 'MongoDB connection URI' });
    }
    if (deps.stripe) {
      vars.push({ key: 'STRIPE_SECRET_KEY', hasDefault: false, defaultValue: null, required: true, description: 'Stripe secret key' });
      vars.push({ key: 'STRIPE_WEBHOOK_SECRET', hasDefault: false, defaultValue: null, required: false, description: 'Stripe webhook signing secret' });
    }
    if (deps.nodemailer || deps['@sendgrid/mail']) {
      vars.push({ key: 'SENDGRID_API_KEY', hasDefault: false, defaultValue: null, required: false, description: 'SendGrid API key for email' });
    }
    if (deps['next-auth'] || deps['@auth/core']) {
      vars.push({ key: 'NEXTAUTH_SECRET', hasDefault: false, defaultValue: null, required: true, description: 'NextAuth secret' });
      vars.push({ key: 'NEXTAUTH_URL', hasDefault: false, defaultValue: 'http://localhost:3000', required: true, description: 'App URL for NextAuth' });
    }
    if (deps['@supabase/supabase-js']) {
      vars.push({ key: 'SUPABASE_URL', hasDefault: false, defaultValue: null, required: true, description: 'Supabase project URL' });
      vars.push({ key: 'SUPABASE_ANON_KEY', hasDefault: false, defaultValue: null, required: true, description: 'Supabase anon key' });
    }
  } catch {}
  return vars;
}
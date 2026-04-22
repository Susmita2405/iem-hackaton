// src/services/github/repo-analyzer.service.js
// Analyzes a GitHub repository to detect stack, framework, and entry points

import { getFileContent } from './github.service.js';
import logger from '../../utils/logger.js';

/**
 * Full repository analysis
 * @param {string} owner
 * @param {string} repo
 * @param {string} githubToken
 * @returns {AnalysisResult}
 */
export async function analyzeRepo(owner, repo, githubToken) {
  const get = (path) => getFileContent(owner, repo, path, githubToken).catch(() => null);

  const result = {
    type: 'unknown',     // 'frontend' | 'backend' | 'fullstack' | 'library'
    frontend: null,      // 'react' | 'next' | 'vue' | 'nuxt' | 'svelte' | 'angular'
    backend: null,       // 'node' | 'express' | 'fastify' | 'nestjs' | 'python' | 'django' | 'fastapi' | 'flask' | 'go'
    runtime: null,       // 'node' | 'python' | 'go' | 'ruby' | 'java' | 'rust'
    packageManager: null, // 'npm' | 'yarn' | 'pnpm' | 'pip' | 'poetry'
    hasDocker: false,
    hasTests: false,
    hasCICD: false,
    entryPoints: {},
    buildCommand: null,
    startCommand: null,
    outputDir: null,
    envVarsNeeded: [],
    packageJson: null,
  };

  // Run all file fetches in parallel for speed
  const [
    pkgJson, requirements, goMod, gemfile, dockerfile,
    envExample, envSample, gitlabCI, githubActions,
    viteConfig, nextConfig, nuxtConfig,
    jestConfig, vitestConfig,
    yarnLock, pnpmLock,
  ] = await Promise.all([
    get('package.json'),
    get('requirements.txt'),
    get('go.mod'),
    get('Gemfile'),
    get('Dockerfile'),
    get('.env.example'),
    get('.env.sample'),
    get('.gitlab-ci.yml'),
    get('.github/workflows/deploy.yml'),
    get('vite.config.js') || get('vite.config.ts'),
    get('next.config.js') || get('next.config.ts') || get('next.config.mjs'),
    get('nuxt.config.js') || get('nuxt.config.ts'),
    get('jest.config.js') || get('jest.config.ts'),
    get('vitest.config.js') || get('vitest.config.ts'),
    get('yarn.lock'),
    get('pnpm-lock.yaml'),
  ]);

  // ── Package manager ────────────────────────────────────────────────────────
  if (pnpmLock) result.packageManager = 'pnpm';
  else if (yarnLock) result.packageManager = 'yarn';
  else if (pkgJson) result.packageManager = 'npm';

  // ── Node.js / JavaScript analysis ─────────────────────────────────────────
  if (pkgJson) {
    try {
      const pkg = JSON.parse(pkgJson);
      result.packageJson = pkg;
      result.runtime = 'node';

      const deps = { ...pkg.dependencies, ...pkg.devDependencies };

      // Frontend framework detection (order matters — more specific first)
      if (nextConfig || deps.next)        result.frontend = 'next';
      else if (nuxtConfig || deps.nuxt || deps['nuxt3'])  result.frontend = 'nuxt';
      else if (deps['@angular/core'])     result.frontend = 'angular';
      else if (deps['svelte'] || deps['@sveltejs/kit']) result.frontend = 'svelte';
      else if (deps.vue || deps['@vue/core']) result.frontend = 'vue';
      else if (deps.react || deps['react-dom']) result.frontend = 'react';

      // Backend framework detection
      if (deps['@nestjs/core'])     result.backend = 'nestjs';
      else if (deps.fastify)        result.backend = 'fastify';
      else if (deps.express)        result.backend = 'express';
      else if (deps.koa)            result.backend = 'koa';
      else if (deps.hapi || deps['@hapi/hapi']) result.backend = 'hapi';
      else if (deps.hono)           result.backend = 'hono';

      // If has backend dep but no frontend, it's a backend app
      if (result.backend && !result.frontend) result.backend = result.backend; // keep

      // Scripts
      if (pkg.scripts?.build)   result.buildCommand = pkg.scripts.build;
      if (pkg.scripts?.start)   result.startCommand = pkg.scripts.start;
      if (pkg.scripts?.dev)     result.entryPoints.dev = pkg.scripts.dev;

      // Output directory hints
      if (result.frontend === 'next')    result.outputDir = '.next';
      else if (viteConfig)               result.outputDir = 'dist';
      else if (result.frontend)          result.outputDir = 'build';

    } catch (err) {
      logger.warn('[repo-analyzer] Failed to parse package.json:', err.message);
    }
  }

  // ── Python analysis ────────────────────────────────────────────────────────
  if (requirements) {
    result.runtime = 'python';
    result.packageManager = 'pip';
    const req = requirements.toLowerCase();
    if (req.includes('django'))   { result.backend = 'django'; }
    else if (req.includes('fastapi')) { result.backend = 'fastapi'; }
    else if (req.includes('flask'))   { result.backend = 'flask'; }
    else if (req.includes('tornado')) { result.backend = 'tornado'; }
  }

  // Check for poetry
  const pyproject = await get('pyproject.toml').catch(() => null);
  if (pyproject) {
    result.packageManager = 'poetry';
    if (!result.runtime) result.runtime = 'python';
  }

  // ── Go analysis ────────────────────────────────────────────────────────────
  if (goMod) {
    result.runtime = 'go';
    result.backend = 'go';
  }

  // ── Ruby analysis ──────────────────────────────────────────────────────────
  if (gemfile) {
    result.runtime = 'ruby';
    const gem = gemfile.toLowerCase();
    if (gem.includes('rails')) result.backend = 'rails';
    else if (gem.includes('sinatra')) result.backend = 'sinatra';
  }

  // ── Infrastructure signals ─────────────────────────────────────────────────
  result.hasDocker = !!dockerfile;
  result.hasTests = !!(jestConfig || vitestConfig);
  result.hasCICD = !!(gitlabCI || githubActions);

  // ── ENV vars ───────────────────────────────────────────────────────────────
  const envContent = envExample || envSample;
  if (envContent) {
    result.envVarsNeeded = parseEnvFile(envContent);
  }

  // ── Determine type ─────────────────────────────────────────────────────────
  if (result.frontend && result.backend) result.type = 'fullstack';
  else if (result.frontend)              result.type = 'frontend';
  else if (result.backend || result.runtime) result.type = 'backend';
  else                                   result.type = 'library';

  logger.info(`[repo-analyzer] ${owner}/${repo}: type=${result.type}, frontend=${result.frontend}, backend=${result.backend}`);
  return result;
}

function parseEnvFile(content) {
  return content
    .split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#') && line.trim())
    .map(line => {
      const eqIdx = line.indexOf('=');
      const key = line.slice(0, eqIdx).trim();
      const value = line.slice(eqIdx + 1).trim().replace(/^["']|["']$/g, '');
      const isPlaceholder = /^(your_|<|YOUR_|xxx|REPLACE)/i.test(value);
      return {
        key,
        hasDefault: value !== '' && !isPlaceholder,
        defaultValue: !isPlaceholder && value ? value : null,
      };
    })
    .filter(v => /^[A-Z_][A-Z0-9_]*$/i.test(v.key));
}
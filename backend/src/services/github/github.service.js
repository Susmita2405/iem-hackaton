// src/services/github/github.service.js
// Octokit wrapper for all GitHub API operations

import { Octokit } from '@octokit/rest';
import simpleGit from 'simple-git';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Create an authenticated Octokit instance for a user
 */
export function getOctokit(githubToken) {
  return new Octokit({ auth: githubToken });
}

/**
 * Clone a repo to a temp directory and return the path
 */
export async function cloneRepo(repoUrl, githubToken) {
  const tmpDir = path.join(os.tmpdir(), `soumyaops_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  // Inject token into URL for private repos
  const authedUrl = repoUrl.replace('https://', `https://oauth2:${githubToken}@`);

  const git = simpleGit();
  await git.clone(authedUrl, tmpDir, ['--depth', '1']);

  return tmpDir;
}

/**
 * Get repository tree (file listing)
 */
export async function getRepoTree(owner, repo, githubToken) {
  const octokit = getOctokit(githubToken);
  const { data } = await octokit.git.getTree({
    owner,
    repo,
    tree_sha: 'HEAD',
    recursive: '1',
  });
  return data.tree.filter(f => f.type === 'blob');
}

/**
 * Get file content from GitHub
 */
export async function getFileContent(owner, repo, filePath, githubToken) {
  const octokit = getOctokit(githubToken);
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path: filePath });
    return Buffer.from(data.content, 'base64').toString('utf-8');
  } catch {
    return null;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// src/services/github/repo-analyzer.service.js
// Analyzes repo structure to detect frontend/backend/fullstack

import { getFileContent } from './github.service.js';

/**
 * Analyze a repository and return its structure + detected stack
 */
export async function analyzeRepo(owner, repo, githubToken, localPath = null) {
  const result = {
    type: 'unknown',   // frontend | backend | fullstack
    frontend: null,    // react | next | vue | svelte | ...
    backend: null,     // node | python | go | ...
    packageJson: null,
    envVarsNeeded: [],
    entryPoints: {},
    hasDocker: false,
  };

  // ── package.json analysis ──────────────────────────────────────────────────
  const pkgContent = await getFileContent(owner, repo, 'package.json', githubToken);
  if (pkgContent) {
    try {
      const pkg = JSON.parse(pkgContent);
      result.packageJson = pkg;

      const deps = {
        ...pkg.dependencies,
        ...pkg.devDependencies,
      };

      // Frontend detection
      if (deps.react || deps.next || deps.vue || deps.svelte || deps.nuxt) {
        if (deps.next || deps.nuxt) result.frontend = deps.next ? 'next' : 'nuxt';
        else if (deps.react) result.frontend = 'react';
        else if (deps.vue) result.frontend = 'vue';
        else result.frontend = 'svelte';
      }

      // Backend detection
      if (deps.express || deps.fastify || deps.koa || deps.hapi || deps.nestjs) {
        result.backend = 'node';
        if (deps['@nestjs/core']) result.backend = 'nestjs';
        else if (deps.fastify) result.backend = 'fastify';
      }

      // Scripts give us entry points
      if (pkg.scripts?.start) result.entryPoints.start = pkg.scripts.start;
      if (pkg.scripts?.build) result.entryPoints.build = pkg.scripts.build;
      if (pkg.scripts?.dev) result.entryPoints.dev = pkg.scripts.dev;
    } catch {}
  }

  // ── Python detection ───────────────────────────────────────────────────────
  const reqContent = await getFileContent(owner, repo, 'requirements.txt', githubToken);
  if (reqContent) {
    if (reqContent.includes('django') || reqContent.includes('flask')
        || reqContent.includes('fastapi')) {
      result.backend = reqContent.includes('django') ? 'django'
        : reqContent.includes('fastapi') ? 'fastapi' : 'flask';
    }
  }

  // ── Docker detection ───────────────────────────────────────────────────────
  const dockerfile = await getFileContent(owner, repo, 'Dockerfile', githubToken);
  result.hasDocker = !!dockerfile;

  // ── ENV var detection ──────────────────────────────────────────────────────
  const envExample = await getFileContent(owner, repo, '.env.example', githubToken)
    || await getFileContent(owner, repo, '.env.sample', githubToken);
  if (envExample) {
    result.envVarsNeeded = parseEnvFile(envExample);
  }

  // ── Determine type ─────────────────────────────────────────────────────────
  if (result.frontend && result.backend) result.type = 'fullstack';
  else if (result.frontend) result.type = 'frontend';
  else if (result.backend) result.type = 'backend';

  return result;
}

function parseEnvFile(content) {
  return content
    .split('\n')
    .filter(line => line.includes('=') && !line.startsWith('#'))
    .map(line => {
      const [key, ...rest] = line.split('=');
      const value = rest.join('=').trim();
      return {
        key: key.trim(),
        hasDefault: value !== '' && !value.startsWith('your_') && !value.startsWith('<'),
        defaultValue: value || null,
      };
    })
    .filter(v => v.key);
}


// ─────────────────────────────────────────────────────────────────────────────
// src/services/github/pr.service.js
// Creates GitHub Pull Requests for suggested fixes — NEVER auto-merges

import { Octokit } from '@octokit/rest';

/**
 * Create a PR with the suggested fix
 * IMPORTANT: This only creates the PR — it never merges
 */
export async function createFixPR({
  githubToken,
  owner,
  repo,
  baseBranch = 'main',
  errorDescription,
  fixExplanation,
  filesChanged,   // [{path: string, before: string, after: string}]
  sourcesUsed,    // RAG sources that informed the fix
}) {
  const octokit = new Octokit({ auth: githubToken });

  // Create a new branch from base
  const branchName = `soumyaops/fix/${Date.now()}`;

  // Get latest commit SHA on base branch
  const { data: refData } = await octokit.git.getRef({
    owner, repo,
    ref: `heads/${baseBranch}`,
  });
  const baseSha = refData.object.sha;

  // Create branch
  await octokit.git.createRef({
    owner, repo,
    ref: `refs/heads/${branchName}`,
    sha: baseSha,
  });

  // Commit each changed file
  for (const file of filesChanged) {
    // Get existing file blob (to get its current SHA for updates)
    let existingSha;
    try {
      const { data: existing } = await octokit.repos.getContent({
        owner, repo, path: file.path, ref: branchName,
      });
      existingSha = existing.sha;
    } catch { /* new file */ }

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: file.path,
      message: `fix: ${errorDescription.slice(0, 72)}`,
      content: Buffer.from(file.after).toString('base64'),
      branch: branchName,
      sha: existingSha,
    });
  }

  // Build PR body with full context
  const sourcesSection = sourcesUsed?.length
    ? `\n## 📚 Knowledge Sources Used\n${sourcesUsed.map(s =>
        `- **${s.source}** (${s.excerpt?.slice(0, 100)}...)`
      ).join('\n')}`
    : '';

  const prBody = `## 🤖 SoumyaOps Auto-Fix Suggestion

**⚠️ This PR was created automatically. Please review ALL changes before merging.**

## 🐛 Error Detected
\`\`\`
${errorDescription}
\`\`\`

## 💡 Explanation
${fixExplanation}

## 📝 Files Changed
${filesChanged.map(f => `- \`${f.path}\``).join('\n')}
${sourcesSection}

---
*Generated by SoumyaOps Debug Engine. Never merged automatically.*`;

  const { data: pr } = await octokit.pulls.create({
    owner, repo,
    title: `[SoumyaOps Fix] ${errorDescription.slice(0, 60)}`,
    head: branchName,
    base: baseBranch,
    body: prBody,
    draft: true, // Always create as draft — requires explicit human review
  });

  return {
    prUrl: pr.html_url,
    prNumber: pr.number,
    branch: branchName,
  };
}
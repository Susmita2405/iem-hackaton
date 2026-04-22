// src/services/deploy/vercel.service.js
// Vercel API integration for frontend deployments

import axios from 'axios';
import { retryWithBackoff } from '../../utils/retry.js';
import logger from '../../utils/logger.js';

const VERCEL_API = 'https://api.vercel.com';

function vercelHeaders() {
  return {
    Authorization: `Bearer ${process.env.VERCEL_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

/**
 * Deploy a frontend repository to Vercel
 * @param {object} params
 * @param {string} params.repoFullName   - "owner/repo"
 * @param {string} params.githubToken
 * @param {object} params.envVars        - { KEY: 'value' }
 * @param {string} params.framework      - 'react' | 'next' | 'vue' | etc
 * @param {string} params.branch         - default 'main'
 * @returns {{ deploymentId, url, projectId }}
 */
export async function deployToVercel({ repoFullName, githubToken, envVars = {}, framework, branch = 'main' }) {
  const repoName = repoFullName.split('/')[1];
  const projectName = repoName.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 48);

  logger.info(`[vercel] Deploying ${repoFullName} (framework: ${framework || 'auto'})`);

  // ── Step 1: Create or get project ─────────────────────────────────────────
  let projectId;
  try {
    const createRes = await retryWithBackoff(() => axios.post(
      `${VERCEL_API}/v10/projects`,
      {
        name: projectName,
        gitRepository: {
          type: 'github',
          repo: repoFullName,
        },
        framework: mapFrameworkId(framework),
        installCommand: null,
        buildCommand: null,
        outputDirectory: null,
      },
      { headers: vercelHeaders() },
    ), { retries: 2 });

    projectId = createRes.data.id;
    logger.info(`[vercel] Project created: ${projectId}`);
  } catch (err) {
    if (err.response?.status === 409) {
      // Project already exists — fetch its ID
      const existing = await axios.get(
        `${VERCEL_API}/v10/projects/${projectName}`,
        { headers: vercelHeaders() },
      );
      projectId = existing.data.id;
      logger.info(`[vercel] Using existing project: ${projectId}`);
    } else {
      throw err;
    }
  }

  // ── Step 2: Set environment variables ─────────────────────────────────────
  if (Object.keys(envVars).length > 0) {
    const envPayload = Object.entries(envVars).map(([key, value]) => ({
      key,
      value: String(value),
      type: 'encrypted',
      target: ['production', 'preview', 'development'],
    }));

    await retryWithBackoff(() => axios.post(
      `${VERCEL_API}/v10/projects/${projectId}/env`,
      envPayload,
      { headers: vercelHeaders() },
    ), { retries: 2 }).catch(err => {
      // Env vars may already exist — ignore 409
      if (err.response?.status !== 409) throw err;
    });

    logger.info(`[vercel] Set ${Object.keys(envVars).length} env vars`);
  }

  // ── Step 3: Trigger deployment ─────────────────────────────────────────────
  const deployRes = await retryWithBackoff(() => axios.post(
    `${VERCEL_API}/v13/deployments`,
    {
      name: projectName,
      gitSource: {
        type: 'github',
        repo: repoFullName,
        ref: branch,
      },
      projectId,
      target: 'production',
    },
    { headers: vercelHeaders() },
  ), { retries: 2 });

  const deployment = deployRes.data;
  const url = deployment.url
    ? `https://${deployment.url}`
    : `https://${projectName}.vercel.app`;

  logger.info(`[vercel] Deployment triggered: ${deployment.id} → ${url}`);

  return {
    deploymentId: deployment.id,
    projectId,
    url,
    inspectorUrl: deployment.inspectorUrl || null,
  };
}

/**
 * Poll deployment status
 */
export async function getVercelDeploymentStatus(deploymentId) {
  const res = await axios.get(
    `${VERCEL_API}/v13/deployments/${deploymentId}`,
    { headers: vercelHeaders() },
  );
  return {
    id: res.data.id,
    status: res.data.readyState, // QUEUED | BUILDING | READY | ERROR | CANCELED
    url: res.data.url ? `https://${res.data.url}` : null,
    createdAt: res.data.createdAt,
  };
}

// ── Framework ID mapping ──────────────────────────────────────────────────────
function mapFrameworkId(detected) {
  const map = {
    next:    'nextjs',
    nextjs:  'nextjs',
    react:   'vite',
    vite:    'vite',
    vue:     'vue',
    nuxt:    'nuxtjs',
    svelte:  'sveltekit',
    angular: 'angular',
    gatsby:  'gatsby',
    remix:   'remix',
    astro:   'astro',
  };
  return map[detected?.toLowerCase()] || null; // null = Vercel auto-detects
}
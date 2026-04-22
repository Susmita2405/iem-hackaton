// src/services/deploy/deploy.service.js
// Orchestrates deployments to Vercel (frontend) and Railway (backend)

import { analyzeRepo } from '../github/repo-analyzer.service.js';
import { deployToVercel } from './vercel.service.js';
import { deployToRailway } from './railway.service.js';
import { query } from '../../config/database.js';
import logger from '../../utils/logger.js';

export async function orchestrateDeploy({ deploymentId, repoId, workspaceId, envVars, userId }) {
  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1`,
    [repoId],
  );
  const { rows: [user] } = await query(
    `SELECT github_token FROM users WHERE id = $1`,
    [userId],
  );

  // Update status
  const updateStatus = async (status, liveUrl = null, logs = null) => {
    await query(
      `UPDATE deployments SET status = $1, live_url = $2, logs = $3, updated_at = NOW() WHERE id = $4`,
      [status, liveUrl, logs, deploymentId],
    );
  };

  try {
    await updateStatus('building');

    const [owner, repoName] = repo.repo_full_name.split('/');
    const analysis = repo.detected_stack || await analyzeRepo(owner, repoName, user.github_token);

    let liveUrl;

    if (analysis.type === 'frontend' || analysis.frontend) {
      logger.info(`Deploying frontend (${analysis.frontend}) to Vercel`);
      const result = await deployToVercel({
        repoFullName: repo.repo_full_name,
        githubToken: user.github_token,
        envVars,
        framework: analysis.frontend,
      });
      liveUrl = result.url;

      await query(
        `UPDATE deployments SET deploy_id = $1, platform = 'vercel' WHERE id = $2`,
        [result.deploymentId, deploymentId],
      );
    }

    if (analysis.type === 'backend' || (analysis.type === 'fullstack' && analysis.backend)) {
      logger.info(`Deploying backend (${analysis.backend}) to Railway`);
      const result = await deployToRailway({
        repoFullName: repo.repo_full_name,
        githubToken: user.github_token,
        envVars,
      });
      liveUrl = liveUrl || result.url;
    }

    await updateStatus('deployed', liveUrl, 'Deployment successful');
    return { liveUrl };
  } catch (err) {
    await updateStatus('failed', null, err.message);
    throw err;
  }
}


// ─────────────────────────────────────────────────────────────────────────────
// src/services/deploy/vercel.service.js

import axios from 'axios';

export async function deployToVercel({ repoFullName, githubToken, envVars, framework }) {
  const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
  const [owner, repo] = repoFullName.split('/');

  // Create Vercel project (idempotent)
  const projectRes = await axios.post(
    'https://api.vercel.com/v10/projects',
    {
      name: repo.toLowerCase().replace(/[^a-z0-9-]/g, '-'),
      gitRepository: {
        type: 'github',
        repo: repoFullName,
      },
      framework: mapFramework(framework),
    },
    {
      headers: {
        Authorization: `Bearer ${VERCEL_TOKEN}`,
        'Content-Type': 'application/json',
      },
    },
  ).catch(e => {
    // Project may already exist
    if (e.response?.status === 409) return { data: { id: null } };
    throw e;
  });

  const projectId = projectRes.data.id;

  // Add env vars
  if (projectId && envVars && Object.keys(envVars).length) {
    await axios.post(
      `https://api.vercel.com/v10/projects/${projectId}/env`,
      Object.entries(envVars).map(([key, value]) => ({
        key,
        value,
        type: 'encrypted',
        target: ['production', 'preview'],
      })),
      { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } },
    );
  }

  // Trigger deployment
  const deployRes = await axios.post(
    'https://api.vercel.com/v13/deployments',
    {
      name: repo,
      gitSource: {
        type: 'github',
        repoId: repoFullName,
        ref: 'main',
      },
    },
    { headers: { Authorization: `Bearer ${VERCEL_TOKEN}` } },
  );

  return {
    deploymentId: deployRes.data.id,
    url: `https://${deployRes.data.url}`,
  };
}

function mapFramework(detected) {
  const map = { react: 'vite', next: 'nextjs', vue: 'vue', nuxt: 'nuxtjs', svelte: 'svelte' };
  return map[detected] || null;
}


// ─────────────────────────────────────────────────────────────────────────────
// src/services/deploy/railway.service.js

export async function deployToRailway({ repoFullName, githubToken, envVars }) {
  const RAILWAY_TOKEN = process.env.RAILWAY_TOKEN;

  // Railway GraphQL API
  const gql = async (query, variables) => {
    const res = await axios.post(
      'https://backboard.railway.app/graphql/v2',
      { query, variables },
      { headers: { Authorization: `Bearer ${RAILWAY_TOKEN}` } },
    );
    return res.data.data;
  };

  // Create project
  const { projectCreate } = await gql(`
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) { id }
    }
  `, { input: { name: repoFullName.split('/')[1] } });

  const projectId = projectCreate.id;

  // Create service from GitHub
  const { serviceCreate } = await gql(`
    mutation CreateService($input: ServiceCreateInput!) {
      serviceCreate(input: $input) { id }
    }
  `, {
    input: {
      projectId,
      source: { repo: repoFullName },
    },
  });

  // Set env vars
  if (envVars && Object.keys(envVars).length) {
    const vars = Object.entries(envVars).map(([name, value]) => ({ name, value }));
    await gql(`
      mutation SetEnvVars($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `, { input: { projectId, serviceId: serviceCreate.id, variables: vars } });
  }

  return { url: `https://${repoFullName.split('/')[1]}.up.railway.app` };
}
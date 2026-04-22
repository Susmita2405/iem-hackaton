// src/services/deploy/railway.service.js
// Railway GraphQL API integration for backend deployments

import axios from 'axios';
import { retryWithBackoff } from '../../utils/retry.js';
import logger from '../../utils/logger.js';

const RAILWAY_API = 'https://backboard.railway.app/graphql/v2';

async function railwayGQL(query, variables = {}) {
  const response = await retryWithBackoff(async () => {
    const res = await axios.post(
      RAILWAY_API,
      { query, variables },
      {
        headers: {
          Authorization: `Bearer ${process.env.RAILWAY_TOKEN}`,
          'Content-Type': 'application/json',
        },
        timeout: 30_000,
      },
    );

    if (res.data.errors?.length) {
      const msg = res.data.errors.map(e => e.message).join(', ');
      throw new Error(`Railway API error: ${msg}`);
    }

    return res.data.data;
  }, { retries: 3, baseDelay: 1000 });

  return response;
}

/**
 * Deploy a backend repository to Railway
 * @param {object} params
 * @param {string} params.repoFullName   - "owner/repo"
 * @param {string} params.githubToken
 * @param {object} params.envVars        - { KEY: 'value' }
 * @param {string} params.branch         - default 'main'
 * @returns {{ projectId, serviceId, url }}
 */
export async function deployToRailway({ repoFullName, githubToken, envVars = {}, branch = 'main' }) {
  const repoName = repoFullName.split('/')[1];
  const projectName = `soumyaops-${repoName}`.toLowerCase().slice(0, 48);

  logger.info(`[railway] Deploying ${repoFullName} to Railway`);

  // ── Step 1: Create project ─────────────────────────────────────────────────
  const { projectCreate } = await railwayGQL(`
    mutation CreateProject($input: ProjectCreateInput!) {
      projectCreate(input: $input) {
        id
        name
      }
    }
  `, { input: { name: projectName } });

  const projectId = projectCreate.id;
  logger.info(`[railway] Project created: ${projectId}`);

  // ── Step 2: Create service from GitHub repo ────────────────────────────────
  const { serviceCreate } = await railwayGQL(`
    mutation CreateService($input: ServiceCreateInput!) {
      serviceCreate(input: $input) {
        id
        name
      }
    }
  `, {
    input: {
      projectId,
      name: repoName,
      source: {
        repo: repoFullName,
        branch,
      },
    },
  });

  const serviceId = serviceCreate.id;
  logger.info(`[railway] Service created: ${serviceId}`);

  // ── Step 3: Set environment variables ─────────────────────────────────────
  if (Object.keys(envVars).length > 0) {
    const variables = {};
    for (const [key, value] of Object.entries(envVars)) {
      variables[key] = String(value);
    }

    await railwayGQL(`
      mutation SetVars($input: VariableCollectionUpsertInput!) {
        variableCollectionUpsert(input: $input)
      }
    `, {
      input: {
        projectId,
        serviceId,
        environmentId: null, // Uses default environment
        variables,
      },
    });

    logger.info(`[railway] Set ${Object.keys(envVars).length} env vars`);
  }

  // ── Step 4: Trigger deployment ─────────────────────────────────────────────
  const { deploymentCreate } = await railwayGQL(`
    mutation CreateDeployment($input: DeploymentCreateInput!) {
      deploymentCreate(input: $input) {
        id
        status
      }
    }
  `, {
    input: {
      projectId,
      serviceId,
    },
  });

  logger.info(`[railway] Deployment triggered: ${deploymentCreate.id}`);

  // ── Step 5: Get service domain ─────────────────────────────────────────────
  let url = null;
  try {
    const { serviceDomainCreate } = await railwayGQL(`
      mutation CreateDomain($input: ServiceDomainCreateInput!) {
        serviceDomainCreate(input: $input) {
          domain
        }
      }
    `, { input: { serviceId, projectId } });
    url = `https://${serviceDomainCreate.domain}`;
  } catch {
    // Domain may already exist or auto-assigned
    url = `https://${repoName}.up.railway.app`;
  }

  logger.info(`[railway] Deployed: ${url}`);

  return {
    projectId,
    serviceId,
    deploymentId: deploymentCreate.id,
    url,
  };
}

/**
 * Get deployment status from Railway
 */
export async function getRailwayDeploymentStatus(deploymentId) {
  const { deployment } = await railwayGQL(`
    query GetDeployment($id: String!) {
      deployment(id: $id) {
        id
        status
        url
        createdAt
      }
    }
  `, { id: deploymentId });

  return deployment;
}
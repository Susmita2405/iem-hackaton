// src/controllers/deploy.controller.js
import { deployQueue } from '../jobs/queue.js';
import { analyzeRepo } from '../services/github/repo-analyzer.service.js';
import { detectEnvVars } from '../services/deploy/env-detector.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * POST /api/deploy
 * Trigger a deployment for a repo
 */
export async function triggerDeploy(req, res) {
  const { workspaceId, repoId, envVars, platform } = req.body;
  if (!workspaceId || !repoId) {
    return res.status(400).json({ error: 'workspaceId and repoId are required' });
  }

  // Verify repo belongs to workspace
  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1 AND workspace_id = $2`,
    [repoId, workspaceId],
  );
  if (!repo) return res.status(404).json({ error: 'Repository not found' });

  // Create deployment record
  const { rows: [deployment] } = await query(
    `INSERT INTO deployments (workspace_id, repo_id, triggered_by, env_vars, platform, deploy_type)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [
      workspaceId,
      repoId,
      req.user.id,
      JSON.stringify(envVars || {}),
      platform || null,
      repo.detected_type || 'unknown',
    ],
  );

  // Queue deployment job
  const job = await deployQueue.add('deploy', {
    deploymentId: deployment.id,
    repoId,
    workspaceId,
    envVars: envVars || {},
    userId: req.user.id,
    platform,
  });

  logger.info(`Deployment queued: ${deployment.id} for repo ${repo.repo_full_name}`);
  res.json({ ok: true, deploymentId: deployment.id, jobId: job.id });
}

/**
 * GET /api/deploy
 * List deployments for a workspace
 */
export async function listDeployments(req, res) {
  const { workspaceId, repoId, status, limit = 20 } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  let sql = `
    SELECT d.*, r.repo_full_name, r.detected_type,
           u.username AS triggered_by_username
    FROM deployments d
    LEFT JOIN repositories r ON r.id = d.repo_id
    LEFT JOIN users u ON u.id = d.triggered_by
    WHERE d.workspace_id = $1
  `;
  const params = [workspaceId];

  if (repoId) { params.push(repoId); sql += ` AND d.repo_id = $${params.length}`; }
  if (status)  { params.push(status);  sql += ` AND d.status = $${params.length}`; }

  params.push(limit);
  sql += ` ORDER BY d.created_at DESC LIMIT $${params.length}`;

  const { rows } = await query(sql, params);
  res.json(rows);
}

/**
 * GET /api/deploy/:id
 * Get a single deployment with full details
 */
export async function getDeployment(req, res) {
  const { id } = req.params;
  const { rows: [deployment] } = await query(
    `SELECT d.*, r.repo_full_name, r.detected_stack
     FROM deployments d
     LEFT JOIN repositories r ON r.id = d.repo_id
     WHERE d.id = $1`,
    [id],
  );
  if (!deployment) return res.status(404).json({ error: 'Deployment not found' });
  res.json(deployment);
}

/**
 * GET /api/deploy/env-preview
 * Preview required ENV vars for a repo before deploying
 */
export async function previewEnvVars(req, res) {
  const { repoId, workspaceId } = req.query;
  if (!repoId) return res.status(400).json({ error: 'repoId is required' });

  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1 AND workspace_id = $2`,
    [repoId, workspaceId],
  );
  if (!repo) return res.status(404).json({ error: 'Repository not found' });

  const { rows: [user] } = await query(
    `SELECT github_token FROM users WHERE id = $1`,
    [req.user.id],
  );

  try {
    const envVars = await detectEnvVars(repo.repo_full_name, user.github_token);
    res.json({
      repoFullName: repo.repo_full_name,
      detectedType: repo.detected_type,
      envVars,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
}

/**
 * POST /api/deploy/:id/cancel
 * Mark a queued deployment as cancelled
 */
export async function cancelDeployment(req, res) {
  const { id } = req.params;
  const { rows: [dep] } = await query(
    `SELECT status FROM deployments WHERE id = $1 AND workspace_id = $2`,
    [id, req.query.workspaceId],
  );
  if (!dep) return res.status(404).json({ error: 'Deployment not found' });
  if (dep.status !== 'queued') {
    return res.status(409).json({ error: `Cannot cancel a ${dep.status} deployment` });
  }

  await query(
    `UPDATE deployments SET status = 'cancelled', updated_at = NOW() WHERE id = $1`,
    [id],
  );
  res.json({ ok: true });
}
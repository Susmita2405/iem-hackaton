// src/controllers/github.controller.js
import { repoAnalyzeQueue } from '../jobs/queue.js';
import { getOctokit } from '../services/github/github.service.js';
import { query } from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * POST /api/github/repos
 * Add a GitHub repository to a workspace and queue analysis
 */
export async function addRepo(req, res) {
  const { workspaceId, repoUrl } = req.body;
  if (!workspaceId || !repoUrl) {
    return res.status(400).json({ error: 'workspaceId and repoUrl are required' });
  }

  // Normalize URL
  const cleanUrl = repoUrl.trim().replace(/\.git$/, '');
  const match = cleanUrl.match(/github\.com\/([^/]+\/[^/]+)/);
  if (!match) return res.status(400).json({ error: 'Invalid GitHub URL' });

  const repoFullName = match[1];

  // Check for duplicates in this workspace
  const { rows: [existing] } = await query(
    `SELECT id FROM repositories WHERE repo_full_name = $1 AND workspace_id = $2`,
    [repoFullName, workspaceId],
  );
  if (existing) return res.status(409).json({ error: 'Repository already added to this workspace' });

  // Verify access via GitHub API
  const { rows: [user] } = await query(
    `SELECT github_token FROM users WHERE id = $1`,
    [req.user.id],
  );

  const [owner, repoName] = repoFullName.split('/');
  try {
    const octokit = getOctokit(user.github_token);
    const { data: repoData } = await octokit.repos.get({ owner, repo: repoName });

    const { rows: [repo] } = await query(
      `INSERT INTO repositories (workspace_id, user_id, repo_url, repo_full_name, default_branch)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [workspaceId, req.user.id, cleanUrl, repoFullName, repoData.default_branch || 'main'],
    );

    // Queue analysis job
    const job = await repoAnalyzeQueue.add('analyze-repo', {
      repoId: repo.id,
      workspaceId,
      userId: req.user.id,
    });

    logger.info(`Repo added: ${repoFullName}, analysis job: ${job.id}`);
    res.json({ ok: true, repo, jobId: job.id });
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: 'Repository not found or no access' });
    throw err;
  }
}

/**
 * GET /api/github/repos
 * List all repositories for a workspace
 */
export async function listRepos(req, res) {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const { rows } = await query(
    `SELECT r.*, u.username AS added_by_username
     FROM repositories r
     LEFT JOIN users u ON u.id = r.user_id
     WHERE r.workspace_id = $1
     ORDER BY r.created_at DESC`,
    [workspaceId],
  );
  res.json(rows);
}

/**
 * GET /api/github/repos/:id
 * Get repo details including detected stack
 */
export async function getRepo(req, res) {
  const { id } = req.params;
  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1`,
    [id],
  );
  if (!repo) return res.status(404).json({ error: 'Repository not found' });
  res.json(repo);
}

/**
 * DELETE /api/github/repos/:id
 * Remove a repository from a workspace
 */
export async function removeRepo(req, res) {
  const { id } = req.params;
  const { workspaceId } = req.query;

  await query(
    `DELETE FROM repositories WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  res.json({ ok: true });
}

/**
 * POST /api/github/repos/:id/reanalyze
 * Re-trigger analysis for an existing repo
 */
export async function reanalyzeRepo(req, res) {
  const { id } = req.params;
  const { workspaceId } = req.body;

  const { rows: [repo] } = await query(
    `SELECT * FROM repositories WHERE id = $1 AND workspace_id = $2`,
    [id, workspaceId],
  );
  if (!repo) return res.status(404).json({ error: 'Repository not found' });

  const job = await repoAnalyzeQueue.add('analyze-repo', {
    repoId: repo.id,
    workspaceId,
    userId: req.user.id,
  });

  res.json({ ok: true, jobId: job.id });
}

/**
 * GET /api/github/prs
 * List PRs created by SoumyaOps for a workspace
 */
export async function listPRs(req, res) {
  const { workspaceId } = req.query;
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId is required' });

  const { rows } = await query(
    `SELECT fs.id, fs.pr_url, fs.pr_number, fs.explanation, fs.status,
            fs.files_changed, fs.sources_used, fs.created_at,
            le.error_message, le.error_type, le.file_path,
            r.repo_full_name
     FROM fix_suggestions fs
     JOIN log_entries le ON le.id = fs.log_entry_id
     LEFT JOIN repositories r ON r.id = le.repo_id
     WHERE fs.workspace_id = $1 AND fs.pr_url IS NOT NULL
     ORDER BY fs.created_at DESC`,
    [workspaceId],
  );
  res.json(rows);
}

/**
 * GET /api/github/user/repos
 * List user's GitHub repos (for repo picker)
 */
export async function listUserRepos(req, res) {
  const { rows: [user] } = await query(
    `SELECT github_token FROM users WHERE id = $1`,
    [req.user.id],
  );

  const octokit = getOctokit(user.github_token);
  const { data } = await octokit.repos.listForAuthenticatedUser({
    sort: 'updated',
    per_page: 50,
  });

  res.json(data.map(r => ({
    id: r.id,
    fullName: r.full_name,
    description: r.description,
    private: r.private,
    language: r.language,
    updatedAt: r.updated_at,
    url: r.html_url,
  })));
}
// src/routes/auth.routes.js
import { Router } from 'express';
import { githubLogin, githubCallback, getMe, logout } from '../controllers/auth.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();
router.get('/github',          githubLogin);
router.get('/github/callback', githubCallback);
router.get('/me',              authMiddleware, getMe);
router.post('/logout',         authMiddleware, logout);
export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/rag.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { ragQuery, ragQueryStream } from '../services/rag/rag.service.js';
import { query } from '../config/database.js';

const router = Router();
router.use(authMiddleware);

// POST /api/rag/query — standard Q&A
router.post('/query', async (req, res) => {
  const { question, workspaceId, filters } = req.body;
  if (!question?.trim()) return res.status(400).json({ error: 'question is required' });

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`, [workspaceId],
  );

  const result = await ragQuery({
    question,
    workspaceId,
    namespace: ws?.pinecone_namespace || workspaceId,
    userId: req.user.id,
    filters: filters || {},
  });

  res.json(result);
});

// GET /api/rag/query/stream — SSE streaming Q&A
router.get('/query/stream', async (req, res) => {
  const { question, workspaceId } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`, [workspaceId],
  );

  await ragQueryStream({
    question,
    workspaceId,
    namespace: ws?.pinecone_namespace || workspaceId,
    userId: req.user.id,
    onChunk: (chunk) => res.write(`data: ${JSON.stringify(chunk)}\n\n`),
  });

  res.write('data: [DONE]\n\n');
  res.end();
});

// GET /api/rag/history — query history
router.get('/history', async (req, res) => {
  const { workspaceId, limit = 20 } = req.query;
  const { rows } = await query(
    `SELECT id, question, answer, sources, tokens_used, latency_ms, created_at
     FROM rag_queries WHERE workspace_id = $1
     ORDER BY created_at DESC LIMIT $2`,
    [workspaceId, limit],
  );
  res.json(rows);
});

export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/ingest.routes.js
import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { embedQueue, logProcessQueue } from '../jobs/queue.js';
import { query } from '../config/database.js';

const router = Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });
router.use(authMiddleware);

// POST /api/ingest/file — upload .txt or .json
router.post('/file', upload.single('file'), async (req, res) => {
  const { workspaceId } = req.body;
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'No file uploaded' });

  const content = file.buffer.toString('utf-8');
  const { rows: [doc] } = await query(
    `INSERT INTO documents (workspace_id, uploaded_by, file_name, file_type, file_size, content)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [workspaceId, req.user.id, file.originalname, file.mimetype, file.size, content],
  );

  const { rows: [ws] } = await query(
    `SELECT pinecone_namespace FROM workspaces WHERE id = $1`, [workspaceId],
  );

  await embedQueue.add('embed-message', {
    type: 'document',
    documentId: doc.id,
    content,
    source: 'document',
    workspaceId,
    metadata: {
      source: 'document',
      workspaceId,
      documentId: doc.id,
      fileName: file.originalname,
      timestamp: new Date().toISOString(),
    },
  });

  res.json({ ok: true, documentId: doc.id, fileName: file.originalname });
});

// POST /api/ingest/logs — paste raw logs
router.post('/logs', async (req, res) => {
  const { workspaceId, rawLog, repoId } = req.body;
  if (!rawLog) return res.status(400).json({ error: 'rawLog is required' });

  const job = await logProcessQueue.add('process-log', { rawLog, workspaceId, repoId });
  res.json({ ok: true, jobId: job.id });
});

export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/github.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { repoAnalyzeQueue } from '../jobs/queue.js';
import { query } from '../config/database.js';

const router = Router();
router.use(authMiddleware);

// POST /api/github/repos — add a repo to a workspace
router.post('/repos', async (req, res) => {
  const { workspaceId, repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });

  const repoFullName = repoUrl.replace('https://github.com/', '').replace(/\.git$/, '');

  const { rows: [repo] } = await query(
    `INSERT INTO repositories (workspace_id, user_id, repo_url, repo_full_name)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT DO NOTHING
     RETURNING *`,
    [workspaceId, req.user.id, repoUrl, repoFullName],
  );

  if (!repo) return res.status(409).json({ error: 'Repo already added' });

  // Queue analysis
  const job = await repoAnalyzeQueue.add('analyze-repo', {
    repoId: repo.id,
    workspaceId,
    userId: req.user.id,
  });

  res.json({ ok: true, repo, jobId: job.id });
});

// GET /api/github/repos — list repos for workspace
router.get('/repos', async (req, res) => {
  const { workspaceId } = req.query;
  const { rows } = await query(
    `SELECT * FROM repositories WHERE workspace_id = $1 ORDER BY created_at DESC`,
    [workspaceId],
  );
  res.json(rows);
});

// GET /api/github/prs — list PRs created by SoumyaOps
router.get('/prs', async (req, res) => {
  const { workspaceId } = req.query;
  const { rows } = await query(
    `SELECT fs.id, fs.pr_url, fs.pr_number, fs.explanation, fs.status, fs.created_at,
            le.error_message, le.error_type
     FROM fix_suggestions fs
     JOIN log_entries le ON le.id = fs.log_entry_id
     WHERE fs.workspace_id = $1 AND fs.pr_url IS NOT NULL
     ORDER BY fs.created_at DESC`,
    [workspaceId],
  );
  res.json(rows);
});

export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/deploy.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { deployQueue } from '../jobs/queue.js';
import { query } from '../config/database.js';

const router = Router();
router.use(authMiddleware);

// POST /api/deploy — trigger a deployment
router.post('/', async (req, res) => {
  const { workspaceId, repoId, envVars } = req.body;

  const { rows: [deployment] } = await query(
    `INSERT INTO deployments (workspace_id, repo_id, triggered_by, env_vars)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [workspaceId, repoId, req.user.id, JSON.stringify(envVars || {})],
  );

  const job = await deployQueue.add('deploy', {
    deploymentId: deployment.id,
    repoId,
    workspaceId,
    envVars: envVars || {},
    userId: req.user.id,
  });

  res.json({ ok: true, deploymentId: deployment.id, jobId: job.id });
});

// GET /api/deploy — list deployments
router.get('/', async (req, res) => {
  const { workspaceId } = req.query;
  const { rows } = await query(
    `SELECT d.*, r.repo_full_name FROM deployments d
     LEFT JOIN repositories r ON r.id = d.repo_id
     WHERE d.workspace_id = $1 ORDER BY d.created_at DESC LIMIT 20`,
    [workspaceId],
  );
  res.json(rows);
});

export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/debug.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { fixGenerateQueue } from '../jobs/queue.js';
import { createPRFromFix } from '../services/debug/debug.service.js';
import { query } from '../config/database.js';

const router = Router();
router.use(authMiddleware);

// GET /api/debug/errors — list detected errors
router.get('/errors', async (req, res) => {
  const { workspaceId, status } = req.query;
  let sql = `SELECT * FROM log_entries WHERE workspace_id = $1`;
  const params = [workspaceId];
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  sql += ` ORDER BY created_at DESC LIMIT 50`;
  const { rows } = await query(sql, params);
  res.json(rows);
});

// POST /api/debug/fix — generate fix for an error
router.post('/fix', async (req, res) => {
  const { logEntryId, workspaceId } = req.body;
  const job = await fixGenerateQueue.add('generate-fix', {
    logEntryId, workspaceId, userId: req.user.id,
  });
  res.json({ ok: true, jobId: job.id });
});

// POST /api/debug/pr — create PR from fix
router.post('/pr', async (req, res) => {
  const { fixId, workspaceId } = req.body;
  const result = await createPRFromFix({ fixId, workspaceId, userId: req.user.id });
  res.json(result);
});

// GET /api/debug/fixes — list fix suggestions
router.get('/fixes', async (req, res) => {
  const { workspaceId } = req.query;
  const { rows } = await query(
    `SELECT fs.*, le.error_message, le.error_type, le.file_path
     FROM fix_suggestions fs
     JOIN log_entries le ON le.id = fs.log_entry_id
     WHERE fs.workspace_id = $1 ORDER BY fs.created_at DESC LIMIT 30`,
    [workspaceId],
  );
  res.json(rows);
});

export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/telegram.routes.js
import { Router } from 'express';
import { handleWebhook, connectBot } from '../controllers/telegram.controller.js';
import { authMiddleware } from '../middleware/auth.middleware.js';

const router = Router();
router.post('/webhook/:workspaceSlug', handleWebhook);
router.post('/connect', authMiddleware, connectBot);
export default router;


// ─────────────────────────────────────────────────────────────────────────────
// src/routes/workspace.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { query } from '../config/database.js';
import { v4 as uuidv4 } from 'uuid';

const router = Router();
router.use(authMiddleware);

router.post('/', async (req, res) => {
  const { name } = req.body;
  const slug = name.toLowerCase().replace(/[^a-z0-9]/g, '-') + '-' + Date.now().toString(36);
  const namespace = `ws_${slug.slice(0, 32)}`;

  const { rows: [ws] } = await query(
    `INSERT INTO workspaces (owner_id, name, slug, pinecone_namespace)
     VALUES ($1, $2, $3, $4) RETURNING *`,
    [req.user.id, name, slug, namespace],
  );
  await query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'owner')`,
    [ws.id, req.user.id],
  );
  res.json(ws);
});

router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT w.* FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE wm.user_id = $1 ORDER BY w.created_at DESC`,
    [req.user.id],
  );
  res.json(rows);
});

router.get('/:id', async (req, res) => {
  const { rows: [ws] } = await query(
    `SELECT w.* FROM workspaces w
     JOIN workspace_members wm ON wm.workspace_id = w.id
     WHERE w.id = $1 AND wm.user_id = $2`,
    [req.params.id, req.user.id],
  );
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.json(ws);
});

export default router;
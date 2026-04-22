// src/routes/github.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import {
  addRepo,
  listRepos,
  getRepo,
  removeRepo,
  reanalyzeRepo,
  listPRs,
  listUserRepos,
} from '../controllers/github.controller.js';

const router = Router();
router.use(authMiddleware);

// Repos
router.post('/repos',                asyncHandler(addRepo));
router.get('/repos',                 asyncHandler(listRepos));
router.get('/repos/user',            asyncHandler(listUserRepos));   // GitHub repo picker
router.get('/repos/:id',             asyncHandler(getRepo));
router.delete('/repos/:id',          asyncHandler(removeRepo));
router.post('/repos/:id/reanalyze',  asyncHandler(reanalyzeRepo));

// Pull Requests created by SoumyaOps
router.get('/prs',                   asyncHandler(listPRs));

export default router;
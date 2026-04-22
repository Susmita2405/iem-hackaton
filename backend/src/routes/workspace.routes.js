// src/routes/workspace.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import {
  createWorkspace,
  listWorkspaces,
  getWorkspace,
  updateWorkspace,
  deleteWorkspace,
  inviteMember,
  removeMember,
} from '../controllers/workspace.controller.js';

const router = Router();
router.use(authMiddleware);

// Workspace CRUD
router.post('/',                         asyncHandler(createWorkspace));
router.get('/',                          asyncHandler(listWorkspaces));
router.get('/:id',                       asyncHandler(getWorkspace));
router.patch('/:id',                     asyncHandler(updateWorkspace));
router.delete('/:id',                    asyncHandler(deleteWorkspace));

// Members
router.post('/:id/invite',               asyncHandler(inviteMember));
router.delete('/:id/members/:userId',    asyncHandler(removeMember));

export default router;
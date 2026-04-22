// src/routes/deploy.routes.js
import { Router } from 'express';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { deployLimiter } from '../middleware/rateLimit.middleware.js';
import {
  triggerDeploy,
  listDeployments,
  getDeployment,
  previewEnvVars,
  cancelDeployment,
} from '../controllers/deploy.controller.js';
import { asyncHandler } from '../middleware/error.middleware.js';

const router = Router();
router.use(authMiddleware);

router.post('/',                    deployLimiter, asyncHandler(triggerDeploy));
router.get('/',                     asyncHandler(listDeployments));
router.get('/env-preview',          asyncHandler(previewEnvVars));
router.get('/:id',                  asyncHandler(getDeployment));
router.post('/:id/cancel',          asyncHandler(cancelDeployment));

export default router;
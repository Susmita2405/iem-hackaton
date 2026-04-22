// src/routes/ingest.routes.js
import { Router } from 'express';
import multer from 'multer';
import { authMiddleware } from '../middleware/auth.middleware.js';
import { ingestLimiter } from '../middleware/rateLimit.middleware.js';
import { asyncHandler } from '../middleware/error.middleware.js';
import {
  uploadFile,
  submitLogs,
  ingestText,
  listDocuments,
  deleteDocument,
  listMessages,
} from '../controllers/ingest.controller.js';

const router = Router();

// Multer in-memory storage — files never touch disk
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['text/plain', 'application/json', 'text/markdown', 'text/csv'];
    if (allowed.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error(`Unsupported file type: ${file.mimetype}`));
    }
  },
});

router.use(authMiddleware);

// File upload
router.post('/file',       ingestLimiter, upload.single('file'), asyncHandler(uploadFile));

// Raw log ingestion
router.post('/logs',       ingestLimiter, asyncHandler(submitLogs));

// Plain text / wiki snippet
router.post('/text',       ingestLimiter, asyncHandler(ingestText));

// List ingested data
router.get('/documents',   asyncHandler(listDocuments));
router.delete('/documents/:id', asyncHandler(deleteDocument));
router.get('/messages',    asyncHandler(listMessages));

export default router;
// src/index.js — SoumyaOps Backend Entry Point
import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import app from './app.js';
import { connectDB } from './config/database.js';
import { connectRedis } from './config/redis.js';
import { startWorkers } from './jobs/queue.js';
import logger from './utils/logger.js';

const PORT = process.env.PORT || 4000;

async function bootstrap() {
  try {
    await connectDB();
    logger.info('PostgreSQL connected');

    await connectRedis();
    logger.info('Redis connected');

    await startWorkers();
    logger.info('BullMQ workers started');

    const server = http.createServer(app);

    // WebSocket for real-time job progress updates to frontend
    const wss = new WebSocketServer({ server, path: '/ws' });
    app.set('wss', wss);

    wss.on('connection', (ws, req) => {
      logger.info('WebSocket client connected');
      ws.on('close', () => logger.info('WebSocket client disconnected'));
    });

    server.listen(PORT, () => {
      logger.info(`SoumyaOps backend running on port ${PORT}`);
    });
  } catch (err) {
    logger.error('Bootstrap failed:', err);
    process.exit(1);
  }
}

bootstrap();
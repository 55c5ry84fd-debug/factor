import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import pino from 'pino';
import pinoHttp from 'pino-http';

import { config } from './config.js';
import { pingDb } from './db/supabase.js';

import { authRouter } from './routes/auth.js';
import { usersRouter } from './routes/users.js';
import { chatsRouter } from './routes/chats.js';
import { messagesRouter } from './routes/messages.js';
import { communitiesRouter } from './routes/communities.js';
import { musicRouter } from './routes/music.js';
import { moderationRouter } from './routes/moderation.js';
import { savedRouter } from './routes/saved.js';
import { devRouter } from './routes/dev.js';

import { attachWebSocket } from './ws/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');

const logger = pino({
  level: config.isProd ? 'info' : 'debug',
  base: { service: 'factor' },
});

const app = express();

app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (config.corsOrigin.includes(origin)) return cb(null, true);
      return cb(new Error('CORS_BLOCKED'));
    },
    credentials: true,
  })
);

app.use(cookieParser());
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

app.use(
  pinoHttp({
    logger,
    customLogLevel: (_req, res, err) => {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    serializers: {
      req: (req) => ({
        id: req.id,
        method: req.method,
        url: req.url,
        ip: req.raw?.ip,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  })
);

app.get('/healthz', async (_req, res) => {
  try {
    await pingDb();
    res.status(200).json({ ok: true, uptime: process.uptime() });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

app.use('/api/auth', authRouter);
app.use('/api/users', usersRouter);
app.use('/api/chats', chatsRouter);
app.use('/api/messages', messagesRouter);
app.use('/api/communities', communitiesRouter);
app.use('/api/music', musicRouter);
app.use('/api/moderation', moderationRouter);
app.use('/api/saved', savedRouter);
app.use('/api/dev', devRouter);

app.use(
  express.static(publicDir, {
    maxAge: config.isProd ? '1h' : 0,
    etag: true,
    setHeaders: (res, filePath) => {
      if (
        filePath.endsWith('sw.js') ||
        filePath.endsWith('index.html') ||
        filePath.endsWith('manifest.webmanifest')
      ) {
        res.setHeader('Cache-Control', 'no-cache');
      }
    },
  })
);

app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ error: 'NOT_FOUND', message: 'Route not found' });
  }
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.use((err, req, res, _next) => {
  const status = Number(err.status) || 500;
  const code = err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
  const message = err.expose || status < 500 ? err.message : 'Internal Server Error';
  if (status >= 500 && req.log) req.log.error({ err }, 'unhandled_request_error');
  res.status(status).json({ error: code, message });
});

const server = http.createServer(app);
const wss = attachWebSocket(server, logger);

server.listen(config.port, () => {
  logger.info(
    { port: config.port, env: config.env, url: config.appUrl },
    'Factor server started'
  );
});

let shuttingDown = false;
function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  try {
    wss.clients.forEach((client) => {
      try {
        client.close(1001, 'server shutting down');
      } catch {
        /* noop */
      }
    });
    wss.close();
  } catch (e) {
    logger.warn({ err: e }, 'ws close warning');
  }

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'server close error');
      process.exit(1);
    }
    logger.info('shutdown complete');
    process.exit(0);
  });

  setTimeout(() => {
    logger.error('shutdown timeout — forcing exit');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

process.on('uncaughtException', (err) => {
  logger.error({ err }, 'uncaughtException');
  process.exit(1);
});
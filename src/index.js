import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import cors from 'cors';
import compression from 'compression';
import { migrate, query } from './db.js';
import { requireAuth, HttpError } from './auth.js';
import { initRealtime } from './realtime.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import conversationRoutes from './routes/conversations.js';
import messageRoutes from './routes/messages.js';
import channelRoutes, { postsRouter, notificationsRouter } from './routes/channels.js';
import momentRoutes, { cleanupMoments } from './routes/moments.js';
import callRoutes from './routes/calls.js';
import fileRoutes from './routes/files.js';
import { pushRouter } from './push.js';

const PORT = Number(process.env.PORT || 4000);

// CLIENT_URL can hold several comma-separated origins, e.g. "https://gochat.netlify.app,http://localhost:5173"
const origins = (process.env.CLIENT_URL || 'http://localhost:5173')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);
const allowedOrigins = origins.includes('*') ? true : origins;

const app = express();
app.set('trust proxy', 1);
app.use(cors({ origin: allowedOrigins, credentials: true }));
app.use(compression());
app.use(express.json({ limit: '1mb' }));

app.get('/', (req, res) => res.json({ name: 'Gochat API', status: 'ok' }));
app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// WebRTC servers for calls. Add a free TURN server in ICE_SERVERS if calls fail on some mobile networks.
app.get('/config', (req, res) => {
  let iceServers = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
  if (process.env.ICE_SERVERS) {
    try {
      iceServers = JSON.parse(process.env.ICE_SERVERS);
    } catch {
      console.error('ICE_SERVERS is not valid JSON; using default STUN servers.');
    }
  }
  res.json({ iceServers, maxUploadMb: Number(process.env.MAX_UPLOAD_MB || 15) });
});

app.use('/auth', authRoutes);
app.use('/files', fileRoutes);
app.use('/users', requireAuth, userRoutes);
app.use('/conversations', requireAuth, conversationRoutes);
app.use('/messages', requireAuth, messageRoutes);
app.use('/channels', requireAuth, channelRoutes);
app.use('/posts', requireAuth, postsRouter);
app.use('/notifications', requireAuth, notificationsRouter);
app.use('/moments', requireAuth, momentRoutes);
app.use('/calls', requireAuth, callRoutes);
app.use('/push', requireAuth, pushRouter);

app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err instanceof HttpError) return res.status(err.status).json({ error: err.message });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid request.' });
  if (err?.code === '22P02') return res.status(400).json({ error: 'Invalid id.' });
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Please try again.' });
});

async function start() {
  await migrate();
  // Calls that were in progress when the server last stopped
  await query(`UPDATE calls SET status = 'missed', ended_at = now() WHERE status = 'ringing'`);
  await query(`UPDATE calls SET status = 'ended', ended_at = now() WHERE status = 'ongoing'`);
  const server = http.createServer(app);
  initRealtime(server, allowedOrigins);
  server.listen(PORT, () => {
    console.log(`Gochat API listening on port ${PORT}`);
    console.log(`Allowed front-end origins: ${origins.join(', ')}`);
  });
  cleanupMoments().catch((e) => console.error('cleanup', e.message));
  setInterval(() => cleanupMoments().catch((e) => console.error('cleanup', e.message)), 30 * 60 * 1000);
}

start().catch((e) => {
  console.error('Failed to start server:', e);
  process.exit(1);
});

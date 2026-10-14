import webpush from 'web-push';
import { Router } from 'express';
import { many, query } from './db.js';
import { ah, HttpError } from './auth.js';

// Free browser push notifications (Web Push with VAPID keys - no paid service needed).
// Generate keys once with:  npm run vapid   and put them in your environment variables.
const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
export const pushEnabled = !!(PUBLIC_KEY && PRIVATE_KEY);

if (pushEnabled) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || 'mailto:admin@example.com', PUBLIC_KEY, PRIVATE_KEY);
} else {
  console.warn('Push notifications are off: set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY (run "npm run vapid").');
}

export async function sendPush(userIds, payload) {
  if (!pushEnabled || !userIds.length) return;
  const subs = await many('SELECT * FROM push_subscriptions WHERE user_id = ANY($1::int[])', [userIds]);
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        JSON.stringify(payload),
        { TTL: 60 * 60 * 12, urgency: 'high' }
      );
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        await query('DELETE FROM push_subscriptions WHERE id = $1', [s.id]).catch(() => {});
      } else {
        console.error('push error', e.statusCode || e.message);
      }
    }
  }));
}

export const pushRouter = Router();

pushRouter.get('/key', (req, res) => res.json({ publicKey: pushEnabled ? PUBLIC_KEY : null }));

pushRouter.post('/subscribe', ah(async (req, res) => {
  const sub = req.body?.subscription;
  if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth) throw new HttpError(400, 'Invalid subscription.');
  await query(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth) VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth`,
    [req.userId, sub.endpoint, sub.keys.p256dh, sub.keys.auth]
  );
  res.json({ ok: true });
}));

pushRouter.post('/unsubscribe', ah(async (req, res) => {
  await query('DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2', [String(req.body?.endpoint || ''), req.userId]);
  res.json({ ok: true });
}));

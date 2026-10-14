import { Router } from 'express';
import { one, many, query } from '../db.js';
import { ah, HttpError } from '../auth.js';
import { contactIds, emitToUsers } from '../realtime.js';

const router = Router();

function serializeMoment(m) {
  return {
    id: m.id,
    userId: m.user_id,
    type: m.type,
    body: m.body,
    background: m.background,
    file: m.file_id ? { id: m.file_id, mime: m.file_mime } : null,
    createdAt: m.created_at,
    expiresAt: m.expires_at,
    viewed: !!m.viewed,
    viewCount: m.view_count,
  };
}

router.get('/', ah(async (req, res) => {
  const contacts = await contactIds(req.userId);
  const blocked = await many('SELECT blocked_id AS id FROM blocks WHERE blocker_id = $1 UNION SELECT blocker_id FROM blocks WHERE blocked_id = $1', [req.userId]);
  const visible = contacts.filter((id) => !blocked.some((b) => b.id === id));
  const rows = await many(
    `SELECT m.*, f.mime AS file_mime, u.name, u.username, u.avatar_id,
       EXISTS (SELECT 1 FROM moment_views v WHERE v.moment_id = m.id AND v.user_id = $1) AS viewed,
       (SELECT count(*) FROM moment_views v WHERE v.moment_id = m.id) AS view_count
     FROM moments m JOIN users u ON u.id = m.user_id LEFT JOIN files f ON f.id = m.file_id
     WHERE m.expires_at > now() AND (m.user_id = $1 OR m.user_id = ANY($2::int[]))
     ORDER BY m.created_at ASC`,
    [req.userId, visible]
  );
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.user_id)) {
      groups.set(r.user_id, { user: { id: r.user_id, name: r.name, username: r.username, avatarId: r.avatar_id }, moments: [] });
    }
    groups.get(r.user_id).moments.push(serializeMoment(r));
  }
  const mine = groups.get(req.userId) || null;
  groups.delete(req.userId);
  const others = [...groups.values()].map((g) => ({
    ...g,
    allViewed: g.moments.every((m) => m.viewed),
    latestAt: g.moments[g.moments.length - 1].createdAt,
  }));
  others.sort((a, b) => (a.allViewed - b.allViewed) || (new Date(b.latestAt) - new Date(a.latestAt)));
  res.json({ mine, others });
}));

router.post('/', ah(async (req, res) => {
  const type = ['text', 'image', 'video'].includes(req.body?.type) ? req.body.type : 'text';
  const body = String(req.body?.body || '').slice(0, 700);
  const background = /^#[0-9a-f]{6}$/i.test(req.body?.background || '') ? req.body.background : '#14213D';
  const fileId = req.body?.fileId || null;
  if (type === 'text' && !body.trim()) throw new HttpError(400, 'Write something for your moment.');
  if (type !== 'text' && !fileId) throw new HttpError(400, 'Attach a photo or video.');
  const m = await one(
    `INSERT INTO moments (user_id, type, body, background, file_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [req.userId, type, body, background, fileId]
  );
  emitToUsers([req.userId, ...(await contactIds(req.userId))], 'moments:changed', {});
  res.status(201).json({ id: m.id });
}));

router.post('/:id/view', ah(async (req, res) => {
  await query(
    `INSERT INTO moment_views (moment_id, user_id)
     SELECT id, $2 FROM moments WHERE id = $1 AND user_id <> $2 ON CONFLICT DO NOTHING`,
    [Number(req.params.id), req.userId]
  );
  res.json({ ok: true });
}));

router.get('/:id/viewers', ah(async (req, res) => {
  const m = await one('SELECT user_id FROM moments WHERE id = $1', [Number(req.params.id)]);
  if (!m || m.user_id !== req.userId) throw new HttpError(403, 'Only you can see who viewed your moment.');
  const rows = await many(
    `SELECT u.id, u.name, u.avatar_id, v.viewed_at FROM moment_views v JOIN users u ON u.id = v.user_id
     WHERE v.moment_id = $1 ORDER BY v.viewed_at DESC`,
    [Number(req.params.id)]
  );
  res.json(rows.map((r) => ({ id: r.id, name: r.name, avatarId: r.avatar_id, viewedAt: r.viewed_at })));
}));

router.delete('/:id', ah(async (req, res) => {
  const m = await one('DELETE FROM moments WHERE id = $1 AND user_id = $2 RETURNING file_id', [Number(req.params.id), req.userId]);
  if (!m) throw new HttpError(404, 'Moment not found.');
  if (m.file_id) await query('DELETE FROM files WHERE id = $1', [m.file_id]).catch(() => {});
  emitToUsers([req.userId, ...(await contactIds(req.userId))], 'moments:changed', {});
  res.json({ ok: true });
}));

// Remove expired moments and their media so the free database stays small
export async function cleanupMoments() {
  const rows = await many('DELETE FROM moments WHERE expires_at < now() RETURNING file_id');
  const ids = rows.map((r) => r.file_id).filter(Boolean);
  if (ids.length) await query('DELETE FROM files WHERE id = ANY($1::uuid[])', [ids]);
  if (rows.length) console.log(`Cleaned up ${rows.length} expired moments.`);
}

export default router;

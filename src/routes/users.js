import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one, many, query } from '../db.js';
import { ah, HttpError } from '../auth.js';
import { publicUser } from '../serializers.js';
import { contactIds, emitToUsers } from '../realtime.js';

const router = Router();

router.get('/me', ah(async (req, res) => {
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  if (!u) throw new HttpError(401, 'Account not found. Please sign in again.');
  res.json(publicUser(u, { self: true }));
}));

router.patch('/me', ah(async (req, res) => {
  const b = req.body || {};
  const sets = [];
  const params = [req.userId];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Name must be 2-60 characters.');
    add('name', name);
  }
  if (b.bio !== undefined) add('bio', String(b.bio).slice(0, 160));
  if (b.phone !== undefined) add('phone', String(b.phone).slice(0, 30) || null);
  if (b.avatarId !== undefined) add('avatar_id', b.avatarId || null);
  if (b.showLastSeen !== undefined) add('show_last_seen', !!b.showLastSeen);
  if (b.readReceipts !== undefined) add('read_receipts', !!b.readReceipts);
  if (b.username !== undefined) {
    const username = String(b.username).trim().toLowerCase().replace(/^@/, '');
    if (!/^[a-z0-9_.]{3,24}$/.test(username)) throw new HttpError(400, 'Username must be 3-24 characters: letters, numbers, _ or .');
    const taken = await one('SELECT 1 FROM users WHERE username = $1 AND id <> $2', [username, req.userId]);
    if (taken) throw new HttpError(409, 'That username is taken.');
    add('username', username);
  }
  if (sets.length) await query(`UPDATE users SET ${sets.join(', ')} WHERE id = $1`, params);
  const u = await one('SELECT * FROM users WHERE id = $1', [req.userId]);
  const contacts = await contactIds(req.userId);
  emitToUsers(contacts, 'user:updated', publicUser(u));
  res.json(publicUser(u, { self: true }));
}));

router.post('/me/password', ah(async (req, res) => {
  const { current, next } = req.body || {};
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!(await bcrypt.compare(String(current || ''), u.password_hash))) throw new HttpError(400, 'Current password is wrong.');
  if (String(next || '').length < 6) throw new HttpError(400, 'New password must be at least 6 characters.');
  await query('UPDATE users SET password_hash = $2 WHERE id = $1', [req.userId, await bcrypt.hash(String(next), 10)]);
  res.json({ ok: true });
}));

router.delete('/me', ah(async (req, res) => {
  const { password } = req.body || {};
  const u = await one('SELECT password_hash FROM users WHERE id = $1', [req.userId]);
  if (!(await bcrypt.compare(String(password || ''), u.password_hash))) throw new HttpError(400, 'Password is wrong.');
  await query('DELETE FROM users WHERE id = $1', [req.userId]);
  res.json({ ok: true });
}));

router.get('/me/blocked', ah(async (req, res) => {
  const rows = await many(
    `SELECT u.* FROM blocks b JOIN users u ON u.id = b.blocked_id WHERE b.blocker_id = $1 ORDER BY u.name`,
    [req.userId]
  );
  res.json(rows.map((u) => publicUser(u)));
}));

// Find people by name, username or email
router.get('/search', ah(async (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  let rows;
  if (!q) {
    // Suggestions: people you already talk to
    rows = await many(
      `SELECT DISTINCT u.* FROM conversation_members m1
       JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
       JOIN users u ON u.id = m2.user_id
       WHERE m1.user_id = $1 AND u.id <> $1 ORDER BY u.name LIMIT 50`,
      [req.userId]
    );
  } else {
    rows = await many(
      `SELECT * FROM users
       WHERE id <> $1 AND (lower(name) LIKE $2 OR username LIKE $2 OR email = $3)
       ORDER BY (username = $3) DESC, name LIMIT 30`,
      [req.userId, `%${q.replace(/[%_]/g, '\\$&')}%`, q]
    );
  }
  res.json(rows.map((u) => publicUser(u)));
}));

router.get('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const u = await one('SELECT * FROM users WHERE id = $1', [id]);
  if (!u) throw new HttpError(404, 'This account no longer exists.');
  const commonGroups = await many(
    `SELECT c.id, c.name, c.avatar_id,
       (SELECT count(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count
     FROM conversations c
     JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = $1
     JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = $2
     WHERE c.type = 'group' ORDER BY c.name`,
    [req.userId, id]
  );
  const blocks = await many(
    'SELECT blocker_id FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)',
    [req.userId, id]
  );
  const direct = await one('SELECT id FROM conversations WHERE direct_key = $1', [
    [req.userId, id].sort((a, b) => a - b).join(':'),
  ]);
  res.json({
    ...publicUser(u),
    commonGroups: commonGroups.map((g) => ({ id: g.id, name: g.name, avatarId: g.avatar_id, memberCount: g.member_count })),
    blockedByMe: blocks.some((b) => b.blocker_id === req.userId),
    blockedMe: blocks.some((b) => b.blocker_id === id),
    directConversationId: direct?.id || null,
  });
}));

router.post('/:id/block', ah(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.userId) throw new HttpError(400, 'You cannot block yourself.');
  await query('INSERT INTO blocks (blocker_id, blocked_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.userId, id]);
  emitToUsers([req.userId, id], 'blocks:changed', {});
  res.json({ ok: true });
}));

router.delete('/:id/block', ah(async (req, res) => {
  const id = Number(req.params.id);
  await query('DELETE FROM blocks WHERE blocker_id = $1 AND blocked_id = $2', [req.userId, id]);
  emitToUsers([req.userId, id], 'blocks:changed', {});
  res.json({ ok: true });
}));

export default router;

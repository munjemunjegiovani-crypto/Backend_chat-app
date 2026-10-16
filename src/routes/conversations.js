import { Router } from 'express';
import crypto from 'node:crypto';
import { one, many, query, pool } from '../db.js';
import { ah, HttpError } from '../auth.js';
import { loadConversations, loadMessage, messageSelect, serializeMessage } from '../serializers.js';
import { emitToUsers, conversationMemberIds, isOnline, markDelivered } from '../realtime.js';
import { sendPush } from '../push.js';

const router = Router();

async function membership(conversationId, userId) {
  const m = await one(
    `SELECT cm.*, c.type, c.only_admins_send FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
    [conversationId, userId]
  );
  if (!m) throw new HttpError(404, 'Conversation not found.');
  return m;
}

async function requireAdmin(conversationId, userId) {
  const m = await membership(conversationId, userId);
  if (m.type !== 'group') throw new HttpError(400, 'Only groups have admins.');
  if (m.role !== 'admin') throw new HttpError(403, 'Only group admins can do that.');
  return m;
}

// Send each member their own view of the conversation (unread counts differ per person)
export async function pushConversation(conversationId, userIds = null) {
  const ids = userIds || (await conversationMemberIds(conversationId));
  for (const uid of ids) {
    const [conv] = await loadConversations(uid, conversationId);
    if (conv) emitToUsers([uid], 'conversation:updated', conv);
  }
}

export async function createSystemMessage(conversationId, actorId, body) {
  const m = await one(
    `INSERT INTO messages (conversation_id, sender_id, type, body) VALUES ($1, $2, 'system', $3) RETURNING id, created_at`,
    [conversationId, actorId, body]
  );
  await query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, m.created_at]);
  const msg = await loadMessage(m.id, actorId);
  emitToUsers(await conversationMemberIds(conversationId), 'message:new', msg);
  return msg;
}

async function userName(id) {
  return (await one('SELECT name FROM users WHERE id = $1', [id]))?.name || 'Someone';
}

router.get('/', ah(async (req, res) => {
  res.json(await loadConversations(req.userId));
}));

router.post('/direct', ah(async (req, res) => {
  const otherId = Number(req.body?.userId);
  if (!otherId || otherId === req.userId) throw new HttpError(400, 'Choose someone to chat with.');
  const other = await one('SELECT id FROM users WHERE id = $1', [otherId]);
  if (!other) throw new HttpError(404, 'User not found.');
  const key = [req.userId, otherId].sort((a, b) => a - b).join(':');
  let conv = await one('SELECT id FROM conversations WHERE direct_key = $1', [key]);
  if (!conv) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const r = await client.query(
        `INSERT INTO conversations (type, direct_key, created_by) VALUES ('direct', $1, $2)
         ON CONFLICT (direct_key) DO UPDATE SET direct_key = EXCLUDED.direct_key RETURNING id`,
        [key, req.userId]
      );
      conv = r.rows[0];
      await client.query(
        `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2), ($1, $3) ON CONFLICT DO NOTHING`,
        [conv.id, req.userId, otherId]
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }
  const [full] = await loadConversations(req.userId, conv.id);
  res.json(full);
}));

router.post('/group', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const description = String(req.body?.description || '').slice(0, 500);
  const memberIds = [...new Set((req.body?.memberIds || []).map(Number).filter((id) => id && id !== req.userId))];
  if (!name || name.length > 60) throw new HttpError(400, 'Please give the group a name (max 60 characters).');
  if (!memberIds.length) throw new HttpError(400, 'Add at least one member.');
  const conv = await one(
    `INSERT INTO conversations (type, name, description, avatar_id, created_by, invite_code)
     VALUES ('group', $1, $2, $3, $4, $5) RETURNING id`,
    [name, description, req.body?.avatarId || null, req.userId, crypto.randomBytes(6).toString('base64url')]
  );
  await query(`INSERT INTO conversation_members (conversation_id, user_id, role) VALUES ($1, $2, 'admin')`, [conv.id, req.userId]);
  await query(
    `INSERT INTO conversation_members (conversation_id, user_id)
     SELECT $1, id FROM users WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING`,
    [conv.id, memberIds]
  );
  await createSystemMessage(conv.id, req.userId, `${await userName(req.userId)} created the group "${name}"`);
  await pushConversation(conv.id);
  const [full] = await loadConversations(req.userId, conv.id);
  res.status(201).json(full);
}));

// Join a group with an invite code
router.get('/join/:code', ah(async (req, res) => {
  const c = await one(
    `SELECT c.id, c.name, c.description, c.avatar_id,
       (SELECT count(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
       EXISTS (SELECT 1 FROM conversation_members x WHERE x.conversation_id = c.id AND x.user_id = $2) AS is_member
     FROM conversations c WHERE c.invite_code = $1 AND c.type = 'group'`,
    [req.params.code, req.userId]
  );
  if (!c) throw new HttpError(404, 'This invite link is invalid or has been reset.');
  res.json({ id: c.id, name: c.name, description: c.description, avatarId: c.avatar_id, memberCount: c.member_count, isMember: c.is_member });
}));

router.post('/join/:code', ah(async (req, res) => {
  const c = await one(`SELECT id FROM conversations WHERE invite_code = $1 AND type = 'group'`, [req.params.code]);
  if (!c) throw new HttpError(404, 'This invite link is invalid or has been reset.');
  const ins = await query(
    `INSERT INTO conversation_members (conversation_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [c.id, req.userId]
  );
  if (ins.rowCount) {
    await createSystemMessage(c.id, req.userId, `${await userName(req.userId)} joined using the invite link`);
    await pushConversation(c.id);
  }
  const [full] = await loadConversations(req.userId, c.id);
  res.json(full);
}));

router.get('/:id', ah(async (req, res) => {
  const [conv] = await loadConversations(req.userId, Number(req.params.id));
  if (!conv) throw new HttpError(404, 'Conversation not found.');
  res.json(conv);
}));

router.patch('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  await requireAdmin(id, req.userId);
  const b = req.body || {};
  const sets = [];
  const params = [id];
  const add = (col, val) => { params.push(val); sets.push(`${col} = $${params.length}`); };
  const notes = [];
  const actor = await userName(req.userId);
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Group name must be 1-60 characters.');
    add('name', name);
    notes.push(`${actor} changed the group name to "${name}"`);
  }
  if (b.description !== undefined) { add('description', String(b.description).slice(0, 500)); notes.push(`${actor} changed the group description`); }
  if (b.avatarId !== undefined) { add('avatar_id', b.avatarId || null); notes.push(`${actor} changed the group photo`); }
  if (b.onlyAdminsSend !== undefined) {
    add('only_admins_send', !!b.onlyAdminsSend);
    notes.push(b.onlyAdminsSend ? `${actor} allowed only admins to send messages` : `${actor} allowed all members to send messages`);
  }
  if (sets.length) await query(`UPDATE conversations SET ${sets.join(', ')} WHERE id = $1`, params);
  for (const n of notes) await createSystemMessage(id, req.userId, n);
  await pushConversation(id);
  const [conv] = await loadConversations(req.userId, id);
  res.json(conv);
}));

// Personal settings: mute, pin, archive, favourite
router.patch('/:id/settings', ah(async (req, res) => {
  const id = Number(req.params.id);
  await membership(id, req.userId);
  const b = req.body || {};
  const sets = [];
  const params = [id, req.userId];
  for (const key of ['muted', 'pinned', 'archived', 'favourite']) {
    if (b[key] !== undefined) { params.push(!!b[key]); sets.push(`${key} = $${params.length}`); }
  }
  if (sets.length) await query(`UPDATE conversation_members SET ${sets.join(', ')} WHERE conversation_id = $1 AND user_id = $2`, params);
  const [conv] = await loadConversations(req.userId, id);
  emitToUsers([req.userId], 'conversation:updated', conv);
  res.json(conv);
}));

router.post('/:id/invite/reset', ah(async (req, res) => {
  const id = Number(req.params.id);
  await requireAdmin(id, req.userId);
  const code = crypto.randomBytes(6).toString('base64url');
  await query('UPDATE conversations SET invite_code = $2 WHERE id = $1', [id, code]);
  res.json({ inviteCode: code });
}));

router.post('/:id/members', ah(async (req, res) => {
  const id = Number(req.params.id);
  await requireAdmin(id, req.userId);
  const userIds = [...new Set((req.body?.userIds || []).map(Number))];
  const added = await many(
    `INSERT INTO conversation_members (conversation_id, user_id)
     SELECT $1, id FROM users WHERE id = ANY($2::int[]) ON CONFLICT DO NOTHING RETURNING user_id`,
    [id, userIds]
  );
  if (added.length) {
    const names = await many('SELECT name FROM users WHERE id = ANY($1::int[])', [added.map((a) => a.user_id)]);
    await createSystemMessage(id, req.userId, `${await userName(req.userId)} added ${names.map((n) => n.name).join(', ')}`);
  }
  await pushConversation(id);
  const [conv] = await loadConversations(req.userId, id);
  res.json(conv);
}));

router.patch('/:id/members/:userId', ah(async (req, res) => {
  const id = Number(req.params.id);
  const target = Number(req.params.userId);
  await requireAdmin(id, req.userId);
  const role = req.body?.role === 'admin' ? 'admin' : 'member';
  await query('UPDATE conversation_members SET role = $3 WHERE conversation_id = $1 AND user_id = $2', [id, target, role]);
  await createSystemMessage(id, req.userId,
    role === 'admin' ? `${await userName(target)} is now an admin` : `${await userName(target)} is no longer an admin`);
  await pushConversation(id);
  const [conv] = await loadConversations(req.userId, id);
  res.json(conv);
}));

// Remove a member (admin) or leave (yourself)
router.delete('/:id/members/:userId', ah(async (req, res) => {
  const id = Number(req.params.id);
  const target = Number(req.params.userId);
  const me = await membership(id, req.userId);
  if (me.type !== 'group') throw new HttpError(400, 'You can only leave groups.');
  if (target !== req.userId && me.role !== 'admin') throw new HttpError(403, 'Only admins can remove members.');
  const before = await conversationMemberIds(id);
  const targetName = await userName(target);
  await query('DELETE FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [id, target]);
  const remaining = before.filter((u) => u !== target);
  if (!remaining.length) {
    await query('DELETE FROM conversations WHERE id = $1', [id]);
  } else {
    // Make sure the group always has an admin
    const admin = await one(`SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND role = 'admin'`, [id]);
    if (!admin) {
      await query(
        `UPDATE conversation_members SET role = 'admin' WHERE conversation_id = $1 AND user_id =
          (SELECT user_id FROM conversation_members WHERE conversation_id = $1 ORDER BY joined_at LIMIT 1)`,
        [id]
      );
    }
    await createSystemMessage(id, req.userId,
      target === req.userId ? `${targetName} left` : `${await userName(req.userId)} removed ${targetName}`);
    await pushConversation(id);
  }
  emitToUsers([target], 'conversation:removed', { conversationId: id });
  res.json({ ok: true });
}));

router.post('/:id/read', ah(async (req, res) => {
  const id = Number(req.params.id);
  const r = await one(
    `UPDATE conversation_members SET last_read_at = now(), last_delivered_at = now()
     WHERE conversation_id = $1 AND user_id = $2 RETURNING last_read_at`,
    [id, req.userId]
  );
  if (!r) throw new HttpError(404, 'Conversation not found.');
  const me = await one('SELECT read_receipts FROM users WHERE id = $1', [req.userId]);
  const members = await conversationMemberIds(id);
  emitToUsers(members, 'receipts', {
    conversationId: id,
    userId: req.userId,
    lastReadAt: me.read_receipts ? r.last_read_at : null,
    lastDeliveredAt: r.last_read_at,
  });
  res.json({ ok: true });
}));

router.post('/:id/clear', ah(async (req, res) => {
  const id = Number(req.params.id);
  await query('UPDATE conversation_members SET cleared_at = now() WHERE conversation_id = $1 AND user_id = $2', [id, req.userId]);
  const [conv] = await loadConversations(req.userId, id);
  emitToUsers([req.userId], 'conversation:updated', conv);
  res.json(conv);
}));

// Delete a direct chat from your list (it reappears if a new message arrives)
router.delete('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const m = await membership(id, req.userId);
  if (m.type === 'group') throw new HttpError(400, 'Leave the group first.');
  await query('UPDATE conversation_members SET cleared_at = now(), archived = false, pinned = false WHERE conversation_id = $1 AND user_id = $2', [id, req.userId]);
  res.json({ ok: true });
}));

router.get('/:id/messages', ah(async (req, res) => {
  const id = Number(req.params.id);
  const m = await membership(id, req.userId);
  const before = Number(req.query.before) || null;
  const params = [id, req.userId, m.cleared_at || new Date(0)];
  let cursor = '';
  if (before) { params.push(before); cursor = `AND m.id < $${params.length}`; }
  const rows = await many(
    `${messageSelect(2)}
     WHERE m.conversation_id = $1 AND m.created_at > $3 ${cursor}
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $2)
     ORDER BY m.id DESC LIMIT 50`,
    params
  );
  res.json({ messages: rows.reverse().map(serializeMessage), hasMore: rows.length === 50 });
}));

router.get('/:id/media', ah(async (req, res) => {
  const id = Number(req.params.id);
  const m = await membership(id, req.userId);
  const rows = await many(
    `${messageSelect(2)}
     WHERE m.conversation_id = $1 AND m.file_id IS NOT NULL AND m.deleted_at IS NULL
       AND m.created_at > $3
       AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $2)
     ORDER BY m.id DESC LIMIT 200`,
    [id, req.userId, m.cleared_at || new Date(0)]
  );
  res.json(rows.map(serializeMessage));
}));

// A reply to a Moment carries a snapshot of it (a small preview image or the text card),
// because the Moment itself fades after 24 hours.
async function cleanMomentQuote(q, conversationId, senderId) {
  if (!q || typeof q !== 'object') return null;
  if (!['text', 'image', 'video'].includes(q.type)) return null;
  const out = {
    type: q.type,
    body: String(q.body || '').slice(0, 200),
    background: /^#[0-9a-fA-F]{3,8}$/.test(q.background || '') ? q.background : '#14213D',
    ownerId: null,
    ownerName: String(q.ownerName || '').slice(0, 60),
    previewId: null,
  };
  const owner = Number(q.ownerId);
  if (owner) {
    const isMember = await one('SELECT 1 FROM conversation_members WHERE conversation_id = $1 AND user_id = $2', [conversationId, owner]);
    if (isMember) out.ownerId = owner;
  }
  if (q.previewId && /^[0-9a-f-]{36}$/i.test(q.previewId)) {
    const f = await one('SELECT 1 FROM files WHERE id = $1 AND owner_id = $2 AND mime LIKE $3', [q.previewId, senderId, 'image/%']);
    if (f) out.previewId = q.previewId;
  }
  // No usable snapshot from the app: for photo moments, keep our own copy of the photo on the server,
  // because the original is deleted when the moment fades.
  if (!out.previewId && q.type === 'image' && Number(q.momentId) && out.ownerId) {
    const src = await one(
      `SELECT f.mime, f.size, f.data FROM moments m JOIN files f ON f.id = m.file_id
       WHERE m.id = $1 AND m.user_id = $2 AND m.expires_at > now() AND f.mime LIKE 'image/%' AND f.size <= 4194304`,
      [Number(q.momentId), out.ownerId]
    );
    if (src) {
      const id = crypto.randomUUID();
      await one(
        'INSERT INTO files (id, owner_id, name, mime, size, data) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
        [id, senderId, 'moment.jpg', src.mime, src.size, src.data]
      );
      out.previewId = id;
    }
  }
  return out;
}

export async function sendMessage(conversationId, senderId, { type = 'text', body = '', fileId = null, replyToId = null, forwarded = false, momentQuote = null }) {
  const m = await membership(conversationId, senderId);
  if (m.type === 'group' && m.only_admins_send && m.role !== 'admin') {
    throw new HttpError(403, 'Only admins can send messages in this group.');
  }
  if (m.type === 'direct') {
    const blocked = await one(
      `SELECT b.blocker_id FROM blocks b JOIN conversation_members o
         ON o.conversation_id = $1 AND o.user_id <> $2
       WHERE (b.blocker_id = $2 AND b.blocked_id = o.user_id) OR (b.blocker_id = o.user_id AND b.blocked_id = $2)`,
      [conversationId, senderId]
    );
    if (blocked) {
      throw new HttpError(403, blocked.blocker_id === senderId ? 'Unblock this contact to send a message.' : 'You cannot message this person.');
    }
  }
  if (!['text', 'image', 'video', 'audio', 'file'].includes(type)) throw new HttpError(400, 'Unknown message type.');
  body = String(body || '').slice(0, 5000);
  if (type === 'text' && !body.trim()) throw new HttpError(400, 'Message is empty.');
  if (type !== 'text' && !fileId) throw new HttpError(400, 'Attachment missing.');
  if (replyToId) {
    const r = await one('SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $2', [replyToId, conversationId]);
    if (!r) replyToId = null;
  }
  const quote = await cleanMomentQuote(momentQuote, conversationId, senderId);
  const row = await one(
    `INSERT INTO messages (conversation_id, sender_id, type, body, file_id, reply_to_id, forwarded, moment_quote)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
    [conversationId, senderId, type, body, fileId, replyToId, forwarded, quote ? JSON.stringify(quote) : null]
  );
  await query('UPDATE conversations SET last_message_at = $2 WHERE id = $1', [conversationId, row.created_at]);
  // Sender has obviously read everything up to their own message; un-archive for everyone
  await query(
    `UPDATE conversation_members SET last_read_at = $3, last_delivered_at = $3 WHERE conversation_id = $1 AND user_id = $2`,
    [conversationId, senderId, row.created_at]
  );
  await query(
    `UPDATE conversation_members SET archived = false WHERE conversation_id = $1 AND archived = true AND muted = false`,
    [conversationId]
  );
  const msg = await loadMessage(row.id, senderId);
  const members = await conversationMemberIds(conversationId);
  emitToUsers(members, 'message:new', msg);
  const online = members.filter((u) => u !== senderId && isOnline(u));
  for (const u of online) await markDelivered(u, [conversationId]);
  notifyOffline(conversationId, senderId, msg).catch((e) => console.error('push', e.message));
  return msg;
}

function preview(msg) {
  if (msg.type === 'image') return msg.body ? `📷 ${msg.body}` : '📷 Photo';
  if (msg.type === 'video') return msg.body ? `🎬 ${msg.body}` : '🎬 Video';
  if (msg.type === 'audio') return '🎙 Voice note';
  if (msg.type === 'file') return `📄 ${msg.file?.name || 'Document'}`;
  return msg.body.length > 140 ? `${msg.body.slice(0, 140)}…` : msg.body;
}

// Push a notification to members who are not currently connected
async function notifyOffline(conversationId, senderId, msg) {
  const rows = await many(
    `SELECT cm.user_id, c.type, c.name FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
     WHERE cm.conversation_id = $1 AND cm.user_id <> $2 AND cm.muted = false`,
    [conversationId, senderId]
  );
  const targets = rows.filter((r) => !isOnline(r.user_id)).map((r) => r.user_id);
  if (!targets.length) return;
  const group = rows[0].type === 'group';
  await sendPush(targets, {
    title: group ? rows[0].name : msg.sender?.name || 'Gochat',
    body: group ? `${msg.sender?.name}: ${preview(msg)}` : preview(msg),
    url: `/chat/${conversationId}`,
    tag: `conv-${conversationId}`,
  });
}

router.post('/:id/messages', ah(async (req, res) => {
  const msg = await sendMessage(Number(req.params.id), req.userId, req.body || {});
  res.status(201).json(msg);
}));

export default router;

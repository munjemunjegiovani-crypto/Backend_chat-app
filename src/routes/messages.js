import { Router } from 'express';
import { one, many, query } from '../db.js';
import { ah, HttpError } from '../auth.js';
import { loadMessage, messageSelect, serializeMessage } from '../serializers.js';
import { emitToUsers, conversationMemberIds } from '../realtime.js';
import { sendMessage } from './conversations.js';

const router = Router();

async function messageForMember(messageId, userId) {
  const m = await one(
    `SELECT m.* FROM messages m
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $2
     WHERE m.id = $1`,
    [messageId, userId]
  );
  if (!m) throw new HttpError(404, 'Message not found.');
  return m;
}

async function broadcastUpdate(messageId, conversationId, viewerId) {
  const msg = await loadMessage(messageId, viewerId);
  emitToUsers(await conversationMemberIds(conversationId), 'message:updated', { ...msg, starred: undefined });
  return msg;
}

router.get('/starred', ah(async (req, res) => {
  const rows = await many(
    `${messageSelect(1)}
     JOIN message_stars st ON st.message_id = m.id AND st.user_id = $1
     JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = $1
     WHERE m.deleted_at IS NULL ORDER BY st.created_at DESC LIMIT 200`,
    [req.userId]
  );
  res.json(rows.map(serializeMessage));
}));

router.patch('/:id', ah(async (req, res) => {
  const m = await messageForMember(Number(req.params.id), req.userId);
  if (m.sender_id !== req.userId) throw new HttpError(403, 'You can only edit your own messages.');
  if (m.deleted_at) throw new HttpError(400, 'This message was deleted.');
  if (m.type !== 'text' && m.type !== 'image' && m.type !== 'video') throw new HttpError(400, 'This message cannot be edited.');
  const body = String(req.body?.body || '').slice(0, 5000);
  if (m.type === 'text' && !body.trim()) throw new HttpError(400, 'Message is empty.');
  await query('UPDATE messages SET body = $2, edited_at = now() WHERE id = $1', [m.id, body]);
  res.json(await broadcastUpdate(m.id, m.conversation_id, req.userId));
}));

router.delete('/:id', ah(async (req, res) => {
  const m = await messageForMember(Number(req.params.id), req.userId);
  if (req.query.scope === 'everyone') {
    let allowed = m.sender_id === req.userId;
    if (!allowed) {
      const me = await one(
        `SELECT cm.role, c.type FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
         WHERE cm.conversation_id = $1 AND cm.user_id = $2`,
        [m.conversation_id, req.userId]
      );
      allowed = me?.type === 'group' && me.role === 'admin';
    }
    if (!allowed) throw new HttpError(403, 'You can only delete your own messages for everyone.');
    await query('UPDATE messages SET deleted_at = now(), body = \'\', file_id = NULL WHERE id = $1', [m.id]);
    await query('DELETE FROM message_reactions WHERE message_id = $1', [m.id]);
    return res.json(await broadcastUpdate(m.id, m.conversation_id, req.userId));
  }
  await query('INSERT INTO message_hidden (message_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [m.id, req.userId]);
  emitToUsers([req.userId], 'message:hidden', { id: m.id, conversationId: m.conversation_id });
  res.json({ ok: true });
}));

router.post('/:id/react', ah(async (req, res) => {
  const m = await messageForMember(Number(req.params.id), req.userId);
  if (m.deleted_at) throw new HttpError(400, 'This message was deleted.');
  const emoji = String(req.body?.emoji || '').slice(0, 16);
  const existing = await one('SELECT emoji FROM message_reactions WHERE message_id = $1 AND user_id = $2', [m.id, req.userId]);
  if (!emoji || existing?.emoji === emoji) {
    await query('DELETE FROM message_reactions WHERE message_id = $1 AND user_id = $2', [m.id, req.userId]);
  } else {
    await query(
      `INSERT INTO message_reactions (message_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (message_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
      [m.id, req.userId, emoji]
    );
  }
  res.json(await broadcastUpdate(m.id, m.conversation_id, req.userId));
}));

router.post('/:id/star', ah(async (req, res) => {
  const m = await messageForMember(Number(req.params.id), req.userId);
  const del = await query('DELETE FROM message_stars WHERE message_id = $1 AND user_id = $2', [m.id, req.userId]);
  if (!del.rowCount) {
    await query('INSERT INTO message_stars (message_id, user_id) VALUES ($1, $2)', [m.id, req.userId]);
  }
  res.json({ starred: !del.rowCount });
}));

router.post('/:id/forward', ah(async (req, res) => {
  const m = await messageForMember(Number(req.params.id), req.userId);
  if (m.deleted_at || m.type === 'system') throw new HttpError(400, 'This message cannot be forwarded.');
  const targets = [...new Set((req.body?.conversationIds || []).map(Number))].slice(0, 10);
  if (!targets.length) throw new HttpError(400, 'Choose at least one chat.');
  const sent = [];
  for (const cid of targets) {
    try {
      sent.push(await sendMessage(cid, req.userId, { type: m.type, body: m.body, fileId: m.file_id, forwarded: true }));
    } catch (e) {
      // skip chats the user cannot send to
    }
  }
  res.json({ sent: sent.length });
}));

export default router;

import { Server } from 'socket.io';
import { verifyToken } from './auth.js';
import { query, one, many } from './db.js';
import { sendPush } from './push.js';

let io = null;
const onlineCounts = new Map(); // userId -> number of open sockets
const activeCalls = new Map(); // callId -> { callerId, calleeId, timer, answered }

export const isOnline = (userId) => (onlineCounts.get(Number(userId)) || 0) > 0;

export function emitToUser(userId, event, payload) {
  if (io) io.to(`user:${userId}`).emit(event, payload);
}

export function emitToUsers(userIds, event, payload) {
  if (!io) return;
  const rooms = [...new Set(userIds.map(Number))].map((id) => `user:${id}`);
  if (rooms.length) io.to(rooms).emit(event, payload);
}

export async function conversationMemberIds(conversationId) {
  const rows = await many('SELECT user_id FROM conversation_members WHERE conversation_id = $1', [conversationId]);
  return rows.map((r) => r.user_id);
}

// Everyone who shares at least one conversation with this user
export async function contactIds(userId) {
  const rows = await many(
    `SELECT DISTINCT m2.user_id FROM conversation_members m1
     JOIN conversation_members m2 ON m2.conversation_id = m1.conversation_id
     WHERE m1.user_id = $1 AND m2.user_id <> $1`,
    [userId]
  );
  return rows.map((r) => r.user_id);
}

// Mark everything in a user's conversations as delivered and tell the senders
export async function markDelivered(userId, conversationIds = null) {
  const rows = conversationIds
    ? await many(
        `UPDATE conversation_members SET last_delivered_at = now()
         WHERE user_id = $1 AND conversation_id = ANY($2::int[]) RETURNING conversation_id, last_delivered_at`,
        [userId, conversationIds]
      )
    : await many(
        `UPDATE conversation_members SET last_delivered_at = now()
         WHERE user_id = $1 RETURNING conversation_id, last_delivered_at`,
        [userId]
      );
  for (const r of rows) {
    const members = await conversationMemberIds(r.conversation_id);
    emitToUsers(
      members.filter((id) => id !== userId),
      'receipts',
      { conversationId: r.conversation_id, userId, lastDeliveredAt: r.last_delivered_at }
    );
  }
}

async function broadcastPresence(userId, online) {
  const user = await one('SELECT last_seen_at, show_last_seen FROM users WHERE id = $1', [userId]);
  if (!user) return;
  const contacts = await contactIds(userId);
  emitToUsers(contacts, 'presence', {
    userId,
    online,
    lastSeenAt: user.show_last_seen ? user.last_seen_at : null,
  });
}

async function finishCall(callId, status, byUserId) {
  const call = activeCalls.get(callId);
  if (!call) return;
  clearTimeout(call.timer);
  activeCalls.delete(callId);
  await query(
    `UPDATE calls SET status = $2, ended_at = now() WHERE id = $1`,
    [callId, status]
  );
  emitToUsers([call.callerId, call.calleeId], 'call:ended', { callId, status, by: byUserId });
  emitToUsers([call.callerId, call.calleeId], 'calls:changed', {});
}

export function initRealtime(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: { origin: allowedOrigins, credentials: true },
    maxHttpBufferSize: 1e6,
    pingInterval: 20000,
    pingTimeout: 20000,
  });

  io.use((socket, next) => {
    const userId = verifyToken(socket.handshake.auth?.token);
    if (!userId) return next(new Error('unauthorized'));
    socket.userId = userId;
    next();
  });

  io.on('connection', async (socket) => {
    const userId = socket.userId;
    socket.join(`user:${userId}`);
    const before = onlineCounts.get(userId) || 0;
    onlineCounts.set(userId, before + 1);
    try {
      if (before === 0) {
        await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
        await broadcastPresence(userId, true);
      }
      await markDelivered(userId);
    } catch (e) {
      console.error('connect handler', e.message);
    }

    socket.on('typing', async ({ conversationId, typing, recording } = {}) => {
      try {
        const members = await conversationMemberIds(conversationId);
        if (!members.includes(userId)) return;
        emitToUsers(members.filter((id) => id !== userId), 'typing', {
          conversationId: Number(conversationId),
          userId,
          typing: !!typing,
          recording: !!recording,
        });
      } catch (e) {
        console.error('typing', e.message);
      }
    });

    // ---- Calls (WebRTC signaling) ----
    socket.on('call:invite', async ({ toUserId, type } = {}, ack) => {
      try {
        toUserId = Number(toUserId);
        if (!toUserId || toUserId === userId) return ack?.({ error: 'Invalid user' });
        const blocked = await one(
          `SELECT 1 FROM blocks WHERE (blocker_id = $1 AND blocked_id = $2) OR (blocker_id = $2 AND blocked_id = $1)`,
          [userId, toUserId]
        );
        if (blocked) return ack?.({ error: 'You cannot call this person.' });
        const busy = [...activeCalls.values()].some(
          (c) => [c.callerId, c.calleeId].includes(toUserId)
        );
        const call = await one(
          `INSERT INTO calls (caller_id, callee_id, type) VALUES ($1, $2, $3) RETURNING id`,
          [userId, toUserId, type === 'video' ? 'video' : 'voice']
        );
        const callId = call.id;
        if (!isOnline(toUserId) || busy) {
          await query(`UPDATE calls SET status = 'missed', ended_at = now() WHERE id = $1`, [callId]);
          emitToUsers([userId, toUserId], 'calls:changed', {});
          if (!busy) {
            const caller = await one('SELECT name FROM users WHERE id = $1', [userId]);
            sendPush([toUserId], {
              title: `Missed ${type === 'video' ? 'video' : 'voice'} call`,
              body: `${caller?.name || 'Someone'} tried to call you. Open Gochat to call back.`,
              url: '/calls',
              tag: `call-${callId}`,
            }).catch(() => {});
          }
          return ack?.({ error: busy ? 'They are on another call.' : 'They are offline right now. Try again later.' });
        }
        const caller = await one('SELECT id, name, username, avatar_id FROM users WHERE id = $1', [userId]);
        const timer = setTimeout(() => finishCall(callId, 'missed', null), 45000);
        activeCalls.set(callId, { callerId: userId, calleeId: toUserId, timer, answered: false });
        emitToUser(toUserId, 'call:incoming', {
          callId,
          type: type === 'video' ? 'video' : 'voice',
          from: { id: caller.id, name: caller.name, username: caller.username, avatarId: caller.avatar_id },
        });
        ack?.({ callId });
      } catch (e) {
        console.error('call:invite', e.message);
        ack?.({ error: 'Could not start the call.' });
      }
    });

    socket.on('call:accept', async ({ callId } = {}) => {
      const call = activeCalls.get(callId);
      if (!call || call.calleeId !== userId) return;
      clearTimeout(call.timer);
      call.answered = true;
      await query(`UPDATE calls SET status = 'ongoing', answered_at = now() WHERE id = $1`, [callId]);
      // Tell the callee's other devices to stop ringing
      emitToUsers([call.callerId, call.calleeId], 'call:accepted', { callId, socketId: socket.id });
    });

    socket.on('call:decline', async ({ callId } = {}) => {
      const call = activeCalls.get(callId);
      if (!call || call.calleeId !== userId) return;
      await finishCall(callId, 'declined', userId);
    });

    socket.on('call:end', async ({ callId } = {}) => {
      const call = activeCalls.get(callId);
      if (!call || ![call.callerId, call.calleeId].includes(userId)) return;
      await finishCall(callId, call.answered ? 'ended' : 'missed', userId);
    });

    socket.on('call:signal', ({ callId, data } = {}) => {
      const call = activeCalls.get(callId);
      if (!call || ![call.callerId, call.calleeId].includes(userId)) return;
      const other = call.callerId === userId ? call.calleeId : call.callerId;
      emitToUser(other, 'call:signal', { callId, data });
    });

    socket.on('disconnect', async () => {
      const count = (onlineCounts.get(userId) || 1) - 1;
      if (count <= 0) {
        onlineCounts.delete(userId);
        try {
          await query('UPDATE users SET last_seen_at = now() WHERE id = $1', [userId]);
          await broadcastPresence(userId, false);
          for (const [callId, c] of activeCalls) {
            if (c.callerId === userId || c.calleeId === userId) {
              await finishCall(callId, c.answered ? 'ended' : 'missed', userId);
            }
          }
        } catch (e) {
          console.error('disconnect handler', e.message);
        }
      } else {
        onlineCounts.set(userId, count);
      }
    });
  });

  return io;
}

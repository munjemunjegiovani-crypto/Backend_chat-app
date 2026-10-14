import { Router } from 'express';
import { many } from '../db.js';
import { ah } from '../auth.js';
import { isOnline } from '../realtime.js';

const router = Router();

router.get('/', ah(async (req, res) => {
  const rows = await many(
    `SELECT c.*, u.id AS other_id, u.name AS other_name, u.username AS other_username, u.avatar_id AS other_avatar
     FROM calls c
     JOIN users u ON u.id = CASE WHEN c.caller_id = $1 THEN c.callee_id ELSE c.caller_id END
     WHERE (c.caller_id = $1 OR c.callee_id = $1) AND c.status <> 'ringing'
     ORDER BY c.started_at DESC LIMIT 100`,
    [req.userId]
  );
  res.json(rows.map((c) => ({
    id: c.id,
    type: c.type,
    status: c.status,
    direction: c.caller_id === req.userId ? 'outgoing' : 'incoming',
    other: { id: c.other_id, name: c.other_name, username: c.other_username, avatarId: c.other_avatar, online: isOnline(c.other_id) },
    startedAt: c.started_at,
    answeredAt: c.answered_at,
    endedAt: c.ended_at,
    duration: c.answered_at && c.ended_at ? Math.round((new Date(c.ended_at) - new Date(c.answered_at)) / 1000) : 0,
  })));
}));

export default router;

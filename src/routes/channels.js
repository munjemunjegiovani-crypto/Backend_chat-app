import { Router } from 'express';
import { one, many, query } from '../db.js';
import { ah, HttpError } from '../auth.js';
import { emitToUsers, emitToUser, isOnline } from '../realtime.js';
import { sendPush } from '../push.js';

const router = Router();
export const notificationsRouter = Router();

const CHANNEL_SELECT = `
  SELECT ch.*, u.name AS owner_name, u.username AS owner_username,
    (SELECT count(*) FROM channel_followers f WHERE f.channel_id = ch.id) AS follower_count,
    (SELECT count(*) FROM channel_posts p WHERE p.channel_id = ch.id) AS post_count,
    me.user_id IS NOT NULL AS following,
    (SELECT count(*) FROM channel_posts p WHERE p.channel_id = ch.id AND me.user_id IS NOT NULL AND p.created_at > me.last_seen_at AND p.author_id <> $1) AS unread,
    (SELECT json_build_object('body', p.body, 'mediaType', p.media_type, 'createdAt', p.created_at)
       FROM channel_posts p WHERE p.channel_id = ch.id ORDER BY p.created_at DESC LIMIT 1) AS last_post
  FROM channels ch
  JOIN users u ON u.id = ch.owner_id
  LEFT JOIN channel_followers me ON me.channel_id = ch.id AND me.user_id = $1`;

function serializeChannel(c, viewerId) {
  return {
    id: c.id,
    name: c.name,
    description: c.description,
    avatarId: c.avatar_id,
    owner: { id: c.owner_id, name: c.owner_name, username: c.owner_username },
    isOwner: c.owner_id === viewerId,
    following: c.following,
    followerCount: c.follower_count,
    postCount: c.post_count,
    unread: c.unread,
    lastPost: c.last_post,
    createdAt: c.created_at,
    lastPostAt: c.last_post_at,
  };
}

const POST_SELECT = `
  SELECT p.*, f.name AS file_name, f.mime AS file_mime, f.size AS file_size,
    u.name AS author_name, u.avatar_id AS author_avatar,
    (SELECT count(*) FROM post_comments c WHERE c.post_id = p.id) AS comment_count,
    COALESCE((SELECT json_agg(json_build_object('emoji', emoji, 'userId', user_id)) FROM post_reactions r WHERE r.post_id = p.id), '[]') AS reactions
  FROM channel_posts p
  LEFT JOIN files f ON f.id = p.file_id
  LEFT JOIN users u ON u.id = p.author_id`;

function serializePost(p) {
  return {
    id: p.id,
    channelId: p.channel_id,
    body: p.body,
    file: p.file_id ? { id: p.file_id, name: p.file_name, mime: p.file_mime, size: p.file_size } : null,
    mediaType: p.media_type,
    author: { id: p.author_id, name: p.author_name, avatarId: p.author_avatar },
    views: p.views,
    commentCount: p.comment_count,
    reactions: p.reactions || [],
    createdAt: p.created_at,
  };
}

async function loadChannel(id, viewerId) {
  const c = await one(`${CHANNEL_SELECT} WHERE ch.id = $2`, [viewerId, id]);
  if (!c) throw new HttpError(404, 'Channel not found.');
  return serializeChannel(c, viewerId);
}

async function loadPost(id) {
  const p = await one(`${POST_SELECT} WHERE p.id = $1`, [id]);
  if (!p) throw new HttpError(404, 'Post not found.');
  return serializePost(p);
}

async function followerIds(channelId) {
  const rows = await many(
    `SELECT user_id FROM channel_followers WHERE channel_id = $1
     UNION SELECT owner_id FROM channels WHERE id = $1`,
    [channelId]
  );
  return rows.map((r) => r.user_id);
}

router.get('/', ah(async (req, res) => {
  const rows = await many(`${CHANNEL_SELECT} ORDER BY COALESCE(ch.last_post_at, ch.created_at) DESC`, [req.userId]);
  const all = rows.map((c) => serializeChannel(c, req.userId));
  res.json({
    mine: all.filter((c) => c.isOwner),
    following: all.filter((c) => c.following && !c.isOwner),
    discover: all
      .filter((c) => !c.following && !c.isOwner)
      .sort((a, b) => b.followerCount - a.followerCount)
      .slice(0, 50),
  });
}));

router.post('/', ah(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  if (!name || name.length > 60) throw new HttpError(400, 'Channel name must be 1-60 characters.');
  const c = await one(
    `INSERT INTO channels (owner_id, name, description, avatar_id) VALUES ($1, $2, $3, $4) RETURNING id`,
    [req.userId, name, String(req.body?.description || '').slice(0, 500), req.body?.avatarId || null]
  );
  res.status(201).json(await loadChannel(c.id, req.userId));
}));

notificationsRouter.get('/', ah(async (req, res) => {
  const rows = await many(
    `SELECT n.*, u.name AS actor_name, u.avatar_id AS actor_avatar, ch.name AS channel_name
     FROM notifications n
     LEFT JOIN users u ON u.id = n.actor_id
     LEFT JOIN channels ch ON ch.id = n.channel_id
     WHERE n.user_id = $1 ORDER BY n.created_at DESC LIMIT 100`,
    [req.userId]
  );
  res.json(rows.map((n) => ({
    id: n.id,
    type: n.type,
    text: n.text,
    actor: n.actor_id ? { id: n.actor_id, name: n.actor_name, avatarId: n.actor_avatar } : null,
    channelId: n.channel_id,
    channelName: n.channel_name,
    postId: n.post_id,
    read: !!n.read_at,
    createdAt: n.created_at,
  })));
}));

notificationsRouter.post('/read', ah(async (req, res) => {
  await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.userId]);
  res.json({ ok: true });
}));

notificationsRouter.get('/count', ah(async (req, res) => {
  const r = await one('SELECT count(*) AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.userId]);
  res.json({ count: r.n });
}));

router.get('/:id', ah(async (req, res) => {
  res.json(await loadChannel(Number(req.params.id), req.userId));
}));

router.patch('/:id', ah(async (req, res) => {
  const id = Number(req.params.id);
  const c = await one('SELECT owner_id FROM channels WHERE id = $1', [id]);
  if (!c) throw new HttpError(404, 'Channel not found.');
  if (c.owner_id !== req.userId) throw new HttpError(403, 'Only the owner can edit this channel.');
  const b = req.body || {};
  if (b.name !== undefined) {
    const name = String(b.name).trim();
    if (!name || name.length > 60) throw new HttpError(400, 'Channel name must be 1-60 characters.');
    await query('UPDATE channels SET name = $2 WHERE id = $1', [id, name]);
  }
  if (b.description !== undefined) await query('UPDATE channels SET description = $2 WHERE id = $1', [id, String(b.description).slice(0, 500)]);
  if (b.avatarId !== undefined) await query('UPDATE channels SET avatar_id = $2 WHERE id = $1', [id, b.avatarId || null]);
  res.json(await loadChannel(id, req.userId));
}));

router.delete('/:id', ah(async (req, res) => {
  const r = await query('DELETE FROM channels WHERE id = $1 AND owner_id = $2', [Number(req.params.id), req.userId]);
  if (!r.rowCount) throw new HttpError(403, 'Only the owner can delete this channel.');
  res.json({ ok: true });
}));

router.post('/:id/follow', ah(async (req, res) => {
  const id = Number(req.params.id);
  const ch = await one('SELECT owner_id, name FROM channels WHERE id = $1', [id]);
  if (!ch) throw new HttpError(404, 'Channel not found.');
  const r = await query('INSERT INTO channel_followers (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, req.userId]);
  if (r.rowCount && ch.owner_id !== req.userId) {
    const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
    await notify(ch.owner_id, req.userId, 'follow', `${me.name} started following ${ch.name}`, id, null);
  }
  res.json(await loadChannel(id, req.userId));
}));

router.delete('/:id/follow', ah(async (req, res) => {
  const id = Number(req.params.id);
  await query('DELETE FROM channel_followers WHERE channel_id = $1 AND user_id = $2', [id, req.userId]);
  res.json(await loadChannel(id, req.userId));
}));

router.get('/:id/posts', ah(async (req, res) => {
  const id = Number(req.params.id);
  const before = Number(req.query.before) || null;
  const params = [id];
  let cursor = '';
  if (before) { params.push(before); cursor = `AND p.id < $2`; }
  const rows = await many(`${POST_SELECT} WHERE p.channel_id = $1 ${cursor} ORDER BY p.id DESC LIMIT 30`, params);
  if (rows.length) {
    await query('UPDATE channel_posts SET views = views + 1 WHERE id = ANY($1::int[])', [rows.map((r) => r.id)]);
  }
  await query('UPDATE channel_followers SET last_seen_at = now() WHERE channel_id = $1 AND user_id = $2', [id, req.userId]);
  res.json({ posts: rows.map(serializePost), hasMore: rows.length === 30 });
}));

router.post('/:id/posts', ah(async (req, res) => {
  const id = Number(req.params.id);
  const ch = await one('SELECT owner_id, name FROM channels WHERE id = $1', [id]);
  if (!ch) throw new HttpError(404, 'Channel not found.');
  if (ch.owner_id !== req.userId) throw new HttpError(403, 'Only the channel owner can post.');
  const body = String(req.body?.body || '').slice(0, 5000);
  const fileId = req.body?.fileId || null;
  if (!body.trim() && !fileId) throw new HttpError(400, 'Write something or attach a photo/video.');
  let mediaType = null;
  if (fileId) {
    const f = await one('SELECT mime FROM files WHERE id = $1', [fileId]);
    mediaType = f?.mime?.startsWith('image/') ? 'image' : f?.mime?.startsWith('video/') ? 'video' : f?.mime?.startsWith('audio/') ? 'audio' : 'file';
  }
  const p = await one(
    `INSERT INTO channel_posts (channel_id, author_id, body, file_id, media_type) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at`,
    [id, req.userId, body, fileId, mediaType]
  );
  await query('UPDATE channels SET last_post_at = $2 WHERE id = $1', [id, p.created_at]);
  const post = await loadPost(p.id);
  emitToUsers(await followerIds(id), 'channel:post', { channelId: id, channelName: ch.name, post });
  res.status(201).json(post);
}));

async function notify(userId, actorId, type, text, channelId, postId) {
  const n = await one(
    `INSERT INTO notifications (user_id, actor_id, type, text, channel_id, post_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
    [userId, actorId, type, text, channelId, postId]
  );
  const actor = await one('SELECT name, avatar_id FROM users WHERE id = $1', [actorId]);
  if (!isOnline(userId)) {
    sendPush([userId], { title: 'Gochat', body: text, url: postId ? `/posts/${postId}` : `/channels/${channelId}`, tag: `n-${n.id}` }).catch(() => {});
  }
  emitToUser(userId, 'notification', {
    id: n.id, type, text, channelId, postId, read: false, createdAt: n.created_at,
    actor: { id: actorId, name: actor?.name, avatarId: actor?.avatar_id },
  });
}

// ---- Posts ----
export const postsRouter = Router();

postsRouter.get('/:id', ah(async (req, res) => {
  const post = await loadPost(Number(req.params.id));
  const comments = await many(
    `SELECT c.*, u.name AS user_name, u.username, u.avatar_id
     FROM post_comments c LEFT JOIN users u ON u.id = c.user_id
     WHERE c.post_id = $1 ORDER BY c.created_at ASC`,
    [post.id]
  );
  const channel = await loadChannel(post.channelId, req.userId);
  res.json({
    post,
    channel,
    comments: comments.map((c) => ({
      id: c.id, body: c.body, parentId: c.parent_id, createdAt: c.created_at,
      user: { id: c.user_id, name: c.user_name, username: c.username, avatarId: c.avatar_id },
    })),
  });
}));

postsRouter.delete('/:id', ah(async (req, res) => {
  const r = await query(
    `DELETE FROM channel_posts p USING channels ch WHERE p.id = $1 AND ch.id = p.channel_id AND ch.owner_id = $2`,
    [Number(req.params.id), req.userId]
  );
  if (!r.rowCount) throw new HttpError(403, 'Only the channel owner can delete posts.');
  res.json({ ok: true });
}));

postsRouter.post('/:id/react', ah(async (req, res) => {
  const id = Number(req.params.id);
  const emoji = String(req.body?.emoji || '').slice(0, 16);
  const existing = await one('SELECT emoji FROM post_reactions WHERE post_id = $1 AND user_id = $2', [id, req.userId]);
  if (!emoji || existing?.emoji === emoji) {
    await query('DELETE FROM post_reactions WHERE post_id = $1 AND user_id = $2', [id, req.userId]);
  } else {
    await query(
      `INSERT INTO post_reactions (post_id, user_id, emoji) VALUES ($1, $2, $3)
       ON CONFLICT (post_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
      [id, req.userId, emoji]
    );
    const p = await one(`SELECT ch.owner_id, ch.id AS channel_id, ch.name FROM channel_posts p JOIN channels ch ON ch.id = p.channel_id WHERE p.id = $1`, [id]);
    if (p && p.owner_id !== req.userId && !existing) {
      const me = await one('SELECT name FROM users WHERE id = $1', [req.userId]);
      await notify(p.owner_id, req.userId, 'reaction', `${me.name} reacted ${emoji} to your post in ${p.name}`, p.channel_id, id);
    }
  }
  const post = await loadPost(id);
  emitToUsers(await followerIds(post.channelId), 'channel:post:updated', post);
  res.json(post);
}));

postsRouter.post('/:id/comments', ah(async (req, res) => {
  const id = Number(req.params.id);
  const body = String(req.body?.body || '').trim().slice(0, 2000);
  if (!body) throw new HttpError(400, 'Comment is empty.');
  const p = await one(
    `SELECT p.id, ch.owner_id, ch.id AS channel_id, ch.name FROM channel_posts p JOIN channels ch ON ch.id = p.channel_id WHERE p.id = $1`,
    [id]
  );
  if (!p) throw new HttpError(404, 'Post not found.');
  let parentId = Number(req.body?.parentId) || null;
  let parent = null;
  if (parentId) {
    parent = await one('SELECT id, user_id FROM post_comments WHERE id = $1 AND post_id = $2', [parentId, id]);
    if (!parent) parentId = null;
  }
  const c = await one(
    `INSERT INTO post_comments (post_id, user_id, parent_id, body) VALUES ($1, $2, $3, $4) RETURNING *`,
    [id, req.userId, parentId, body]
  );
  const me = await one('SELECT name, username, avatar_id FROM users WHERE id = $1', [req.userId]);
  const preview = body.length > 80 ? `${body.slice(0, 80)}…` : body;
  if (p.owner_id !== req.userId) {
    await notify(p.owner_id, req.userId, 'comment', `${me.name} commented on your post in ${p.name}: "${preview}"`, p.channel_id, id);
  }
  if (parent && parent.user_id !== req.userId && parent.user_id !== p.owner_id) {
    await notify(parent.user_id, req.userId, 'reply', `${me.name} replied to your comment: "${preview}"`, p.channel_id, id);
  }
  const comment = {
    id: c.id, body: c.body, parentId: c.parent_id, createdAt: c.created_at,
    user: { id: req.userId, name: me.name, username: me.username, avatarId: me.avatar_id },
  };
  emitToUsers(await followerIds(p.channel_id), 'post:comment', { postId: id, comment });
  res.status(201).json(comment);
}));

postsRouter.delete('/comments/:commentId', ah(async (req, res) => {
  const r = await query(
    `DELETE FROM post_comments c USING channel_posts p, channels ch
     WHERE c.id = $1 AND p.id = c.post_id AND ch.id = p.channel_id AND (c.user_id = $2 OR ch.owner_id = $2)`,
    [Number(req.params.commentId), req.userId]
  );
  if (!r.rowCount) throw new HttpError(403, 'You cannot delete this comment.');
  res.json({ ok: true });
}));

export default router;

import { many, one } from './db.js';
import { isOnline } from './realtime.js';

export function publicUser(u, { self = false } = {}) {
  if (!u) return null;
  const out = {
    id: u.id,
    name: u.name,
    username: u.username,
    bio: u.bio,
    avatarId: u.avatar_id,
    online: isOnline(u.id),
    lastSeenAt: u.show_last_seen || self ? u.last_seen_at : null,
    createdAt: u.created_at,
  };
  if (self) {
    out.email = u.email;
    out.phone = u.phone;
    out.showLastSeen = u.show_last_seen;
    out.readReceipts = u.read_receipts;
  }
  return out;
}

const MESSAGE_SELECT = `
  SELECT m.*, u.name AS sender_name, u.username AS sender_username, u.avatar_id AS sender_avatar,
    f.name AS file_name, f.mime AS file_mime, f.size AS file_size,
    r.id AS r_id, r.body AS r_body, r.type AS r_type, r.deleted_at AS r_deleted, r.sender_id AS r_sender_id,
    ru.name AS r_sender_name,
    COALESCE((SELECT json_agg(json_build_object('emoji', emoji, 'userId', user_id))
              FROM message_reactions WHERE message_id = m.id), '[]') AS reactions,
    EXISTS (SELECT 1 FROM message_stars s WHERE s.message_id = m.id AND s.user_id = $VIEWER) AS starred
  FROM messages m
  LEFT JOIN users u ON u.id = m.sender_id
  LEFT JOIN files f ON f.id = m.file_id
  LEFT JOIN messages r ON r.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = r.sender_id`;

export function messageSelect(viewerParamIndex) {
  return MESSAGE_SELECT.replace('$VIEWER', `$${viewerParamIndex}`);
}

export function serializeMessage(m) {
  const deleted = !!m.deleted_at;
  return {
    id: m.id,
    conversationId: m.conversation_id,
    sender: m.sender_id
      ? { id: m.sender_id, name: m.sender_name, username: m.sender_username, avatarId: m.sender_avatar }
      : null,
    type: deleted ? 'text' : m.type,
    body: deleted ? '' : m.body,
    file: !deleted && m.file_id ? { id: m.file_id, name: m.file_name, mime: m.file_mime, size: m.file_size } : null,
    replyTo: m.r_id
      ? {
          id: m.r_id,
          senderId: m.r_sender_id,
          senderName: m.r_sender_name,
          type: m.r_deleted ? 'text' : m.r_type,
          body: m.r_deleted ? 'This message was deleted' : m.r_body,
        }
      : null,
    forwarded: m.forwarded,
    editedAt: m.edited_at,
    deletedAt: m.deleted_at,
    createdAt: m.created_at,
    reactions: deleted ? [] : m.reactions || [],
    starred: !!m.starred,
  };
}

export async function loadMessage(messageId, viewerId) {
  const row = await one(`${messageSelect(2)} WHERE m.id = $1`, [messageId, viewerId]);
  return row ? serializeMessage(row) : null;
}

// Full conversation info for one viewer (used in list + detail)
export async function loadConversations(viewerId, conversationId = null) {
  const params = [viewerId];
  let filter = '';
  if (conversationId) {
    params.push(conversationId);
    filter = 'AND c.id = $2';
  }
  const rows = await many(
    `SELECT c.*, cm.role, cm.muted, cm.pinned, cm.archived, cm.favourite, cm.last_read_at, cm.cleared_at,
      (SELECT count(*) FROM conversation_members x WHERE x.conversation_id = c.id) AS member_count,
      (SELECT count(*) FROM messages m
         WHERE m.conversation_id = c.id AND m.created_at > cm.last_read_at
           AND m.created_at > COALESCE(cm.cleared_at, '-infinity')
           AND (m.sender_id IS DISTINCT FROM $1) AND m.type <> 'system' AND m.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $1)
      ) AS unread,
      lm.id AS lm_id
     FROM conversation_members cm
     JOIN conversations c ON c.id = cm.conversation_id
     LEFT JOIN LATERAL (
       SELECT m.id FROM messages m
       WHERE m.conversation_id = c.id AND m.created_at > COALESCE(cm.cleared_at, '-infinity')
         AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = $1)
       ORDER BY m.created_at DESC, m.id DESC LIMIT 1
     ) lm ON true
     WHERE cm.user_id = $1 ${filter}
     ORDER BY c.last_message_at DESC`,
    params
  );
  if (!rows.length) return [];

  const ids = rows.map((r) => r.id);
  const memberRows = await many(
    `SELECT cm.conversation_id, cm.role, cm.last_read_at, cm.last_delivered_at, cm.joined_at,
            u.id, u.name, u.username, u.bio, u.avatar_id, u.last_seen_at, u.show_last_seen, u.read_receipts, u.created_at
     FROM conversation_members cm JOIN users u ON u.id = cm.user_id
     WHERE cm.conversation_id = ANY($1::int[])
     ORDER BY cm.role, u.name`,
    [ids]
  );
  const lastIds = rows.map((r) => r.lm_id).filter(Boolean);
  const lastMessages = lastIds.length
    ? await many(`${messageSelect(2)} WHERE m.id = ANY($1::int[])`, [lastIds, viewerId])
    : [];
  const lastById = new Map(lastMessages.map((m) => [m.id, serializeMessage(m)]));
  const blockedRows = await many(
    'SELECT blocked_id, blocker_id FROM blocks WHERE blocker_id = $1 OR blocked_id = $1',
    [viewerId]
  );

  return rows.map((c) => {
    const members = memberRows
      .filter((m) => m.conversation_id === c.id)
      .map((m) => ({
        ...publicUser(m),
        role: m.role,
        joinedAt: m.joined_at,
        lastReadAt: m.read_receipts ? m.last_read_at : null,
        lastDeliveredAt: m.last_delivered_at,
      }));
    const other = c.type === 'direct' ? members.find((m) => m.id !== viewerId) || null : null;
    return {
      id: c.id,
      type: c.type,
      name: c.type === 'direct' ? other?.name || 'Deleted account' : c.name,
      description: c.description,
      avatarId: c.type === 'direct' ? other?.avatarId || null : c.avatar_id,
      inviteCode: c.type === 'group' && c.role === 'admin' ? c.invite_code : undefined,
      onlyAdminsSend: c.only_admins_send,
      createdBy: c.created_by,
      createdAt: c.created_at,
      lastMessageAt: c.last_message_at,
      role: c.role,
      muted: c.muted,
      pinned: c.pinned,
      archived: c.archived,
      favourite: c.favourite,
      unread: c.unread,
      memberCount: c.member_count,
      members,
      other,
      blockedByMe: other ? blockedRows.some((b) => b.blocker_id === viewerId && b.blocked_id === other.id) : false,
      blockedMe: other ? blockedRows.some((b) => b.blocked_id === viewerId && b.blocker_id === other.id) : false,
      lastMessage: c.lm_id ? lastById.get(c.lm_id) || null : null,
    };
  });
}

import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { one } from '../db.js';
import { ah, signToken, HttpError } from '../auth.js';
import { publicUser } from '../serializers.js';

const router = Router();

// Very small in-memory limiter to slow down password guessing
const attempts = new Map();
function limit(key) {
  const now = Date.now();
  const list = (attempts.get(key) || []).filter((t) => now - t < 15 * 60 * 1000);
  list.push(now);
  attempts.set(key, list);
  if (list.length > 100) throw new HttpError(429, 'Too many attempts. Please wait a few minutes.');
}

const USERNAME_RE = /^[a-z0-9_.]{3,24}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.post('/register', ah(async (req, res) => {
  limit(`reg:${req.ip}`);
  let { name, username, email, password } = req.body || {};
  name = String(name || '').trim();
  username = String(username || '').trim().toLowerCase().replace(/^@/, '');
  email = String(email || '').trim().toLowerCase();
  password = String(password || '');
  if (name.length < 2 || name.length > 60) throw new HttpError(400, 'Please enter your full name.');
  if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3-24 characters: letters, numbers, _ or .');
  if (!EMAIL_RE.test(email)) throw new HttpError(400, 'Please enter a valid email address.');
  if (password.length < 6) throw new HttpError(400, 'Password must be at least 6 characters.');

  const exists = await one('SELECT email, username FROM users WHERE email = $1 OR username = $2', [email, username]);
  if (exists) {
    throw new HttpError(409, exists.email === email ? 'An account with this email already exists.' : 'That username is taken.');
  }
  const hash = await bcrypt.hash(password, 10);
  const user = await one(
    `INSERT INTO users (name, username, email, password_hash) VALUES ($1, $2, $3, $4) RETURNING *`,
    [name, username, email, hash]
  );
  res.status(201).json({ token: signToken(user.id), user: publicUser(user, { self: true }) });
}));

router.post('/login', ah(async (req, res) => {
  limit(`login:${req.ip}`);
  const login = String(req.body?.login || '').trim().toLowerCase().replace(/^@/, '');
  const password = String(req.body?.password || '');
  const user = await one('SELECT * FROM users WHERE email = $1 OR username = $1', [login]);
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    throw new HttpError(401, 'Wrong email/username or password.');
  }
  res.json({ token: signToken(user.id), user: publicUser(user, { self: true }) });
}));

export default router;

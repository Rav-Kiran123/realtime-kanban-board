// /api/auth  -> register, login, "who am I"
const express = require('express');
const bcrypt = require('bcryptjs');
const { getDb } = require('../db/database');
const { signToken } = require('../services/auth');
const { getAccessTree } = require('../services/access');
const { requireAuth } = require('../middleware/auth');
const { requireText } = require('../utils/validate');
const { badRequest, unauthorized, conflict } = require('../utils/httpError');
const { toUser } = require('../utils/mappers');

const router = express.Router();

// random-ish avatar colour so presence bubbles look different
const COLORS = ['#e76f51', '#2a9d8f', '#8338ec', '#3a86ff', '#ff006e', '#fb8500', '#06d6a0', '#118ab2'];

router.post('/register', (req, res) => {
  const body = req.body || {};
  const name = requireText(body.name, 'name', 80);
  const email = requireText(body.email, 'email', 120).toLowerCase();
  const password = typeof body.password === 'string' ? body.password : '';

  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw badRequest('Please enter a valid email');
  if (password.length < 8) throw badRequest('Password must be at least 8 characters');

  const db = getDb();
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw conflict('An account with this email already exists');

  const color = COLORS[Math.floor(Math.random() * COLORS.length)];
  const info = db.prepare('INSERT INTO users (name, email, password_hash, avatar_color) VALUES (?, ?, ?, ?)')
    .run(name, email, bcrypt.hashSync(password, 10), color);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);

  // a brand new user has no orgs yet - they can create one or be invited
  res.status(201).json({ token: signToken(user), user: toUser(user) });
});

router.post('/login', (req, res) => {
  const body = req.body || {};
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');

  const user = getDb().prepare('SELECT * FROM users WHERE email = ?').get(email);
  // same message for "no such user" and "wrong password" (don't reveal which emails exist)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    throw unauthorized('Wrong email or password');
  }
  res.json({ token: signToken(user), user: toUser(user) });
});

// user + every org/branch they can open (drives the org selector & branch switcher)
router.get('/me', requireAuth, (req, res) => {
  res.json({ user: toUser(req.user), orgs: getAccessTree(req.user.id) });
});

module.exports = router;

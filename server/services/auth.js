// Login tokens (JWT). The SAME token is used for REST calls and for the
// WebSocket handshake, so both entry points authenticate identically.
const jwt = require('jsonwebtoken');
const config = require('../config');
const { getDb } = require('../db/database');

function signToken(user) {
  return jwt.sign({ sub: user.id, name: user.name }, config.JWT_SECRET, { expiresIn: config.JWT_EXPIRES_IN });
}

// Returns the user row, or null if the token is bad/expired/user deleted.
function userFromToken(token) {
  if (!token) return null;
  try {
    const payload = jwt.verify(token, config.JWT_SECRET);
    const user = getDb().prepare('SELECT id, name, email, avatar_color FROM users WHERE id = ?').get(payload.sub);
    return user || null;
  } catch {
    return null;
  }
}

module.exports = { signToken, userFromToken };

// Checks the "Authorization: Bearer <token>" header and sets req.user.
const { userFromToken } = require('../services/auth');
const { unauthorized } = require('../utils/httpError');

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;

  const user = userFromToken(token);
  if (!user) return next(unauthorized('Your session is missing or expired - please log in again'));

  req.user = user;
  next();
}

module.exports = { requireAuth };

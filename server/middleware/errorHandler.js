// Last middleware in the chain: turns any thrown error into a JSON response.
// Format is always { error: 'CODE', message: 'human text', ...extra }
const { HttpError } = require('../utils/httpError');

function errorHandler(err, req, res, next) { // eslint-disable-line no-unused-vars
  if (err instanceof HttpError) {
    return res.status(err.status).json({ error: err.code, message: err.message, ...err.extra });
  }

  // express.json() failed to parse the body
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'BAD_REQUEST', message: 'Request body is not valid JSON' });
  }

  // a DB constraint (unique name, foreign key ...) - most likely a bad request
  if (/constraint/i.test(err.message || '')) {
    return res.status(409).json({ error: 'CONSTRAINT', message: 'That would break a data rule (duplicate name or invalid reference)' });
  }

  console.error('[unexpected error]', err);
  res.status(500).json({ error: 'INTERNAL', message: 'Something went wrong on the server' });
}

module.exports = { errorHandler };

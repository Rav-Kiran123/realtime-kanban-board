// One error class for the whole API. Route code just does `throw notFound('Task')`
// and the error middleware turns it into a proper JSON response.
class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra; // extra fields copied into the JSON response
  }
}

const badRequest = (message) => new HttpError(400, 'BAD_REQUEST', message);
const unauthorized = (message = 'Please log in first') => new HttpError(401, 'UNAUTHORIZED', message);
const forbidden = (message = 'You are not allowed to do this') => new HttpError(403, 'FORBIDDEN', message);

// NOTE: for other tenants' data I always answer 404 (not 403) so an attacker
// can't even find out whether an id exists in some other branch.
const notFound = (what = 'Resource') => new HttpError(404, 'NOT_FOUND', `${what} not found`);

// 409 used by optimistic locking - we send back the latest copy so the client can merge
const versionConflict = (current, message = 'Someone else changed this item before you') =>
  new HttpError(409, 'VERSION_CONFLICT', message, { current });

const conflict = (message) => new HttpError(409, 'CONFLICT', message);

module.exports = { HttpError, badRequest, unauthorized, forbidden, notFound, versionConflict, conflict };

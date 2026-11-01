// Very small input validation helpers. I didn't want a big library like Joi
// for a handful of fields, so these just check and clean one value each.
const { badRequest, notFound } = require('./httpError');

// required, non-empty string (trimmed)
function requireText(value, field, max = 200) {
  if (typeof value !== 'string' || !value.trim()) throw badRequest(`${field} is required`);
  const text = value.trim();
  if (text.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return text;
}

// optional string - undefined means "not sent", null becomes ''
function optionalText(value, field, max = 5000) {
  if (value === undefined) return undefined;
  if (value === null) return '';
  if (typeof value !== 'string') throw badRequest(`${field} must be text`);
  if (value.length > max) throw badRequest(`${field} is too long (max ${max} characters)`);
  return value;
}

// every update request must say which version it was based on
function requireVersion(value) {
  if (!Number.isInteger(value) || value < 1) {
    throw badRequest('version (integer) is required - it is used to detect conflicting edits');
  }
  return value;
}

// optional id in a body (null/undefined -> null)
function optionalId(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw badRequest(`${field} must be a positive integer`);
  return n;
}

// id taken from the URL - anything weird is simply "not found"
function paramId(value, what) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw notFound(what);
  return n;
}

function oneOf(value, field, allowed) {
  if (!allowed.includes(value)) throw badRequest(`${field} must be one of: ${allowed.join(', ')}`);
  return value;
}

// 'YYYY-MM-DD' or null
function optionalDate(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || isNaN(Date.parse(value))) {
    throw badRequest(`${field} must be a date like 2026-12-31`);
  }
  return value;
}

function optionalPositiveInt(value, field) {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 999) throw badRequest(`${field} must be a number between 1 and 999`);
  return n;
}

module.exports = {
  requireText, optionalText, requireVersion, optionalId, paramId, oneOf, optionalDate, optionalPositiveInt,
};

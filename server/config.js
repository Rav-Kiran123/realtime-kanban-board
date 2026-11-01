// All settings live here so I don't have magic values spread around the code.
// Every value can be overridden with an environment variable.
const path = require('path');

module.exports = {
  PORT: Number(process.env.PORT ?? 4000),

  // NOTE: in a real deployment this MUST come from an env variable / secret store
  JWT_SECRET: process.env.JWT_SECRET || 'dev-only-secret-please-change-me',
  JWT_EXPIRES_IN: '12h',

  // ':memory:' is used by the tests so every test run starts fresh
  DB_FILE: process.env.DB_FILE || path.join(__dirname, '..', 'data', 'teamboard.db'),

  // fill an empty database with demo orgs/branches/users on first start
  SEED_DEMO_DATA: process.env.SEED_DEMO_DATA !== 'false',
};

// Small wrapper around Node's built-in SQLite driver (node:sqlite, Node 22.13+).
// I picked SQLite so the project runs with zero setup - no MySQL/Postgres needed.
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const config = require('../config');

let db = null;

// Opens the database file and makes sure all tables exist.
function initDb(file = config.DB_FILE) {
  if (db) return db;

  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }

  db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');   // SQLite has FKs OFF by default!
  db.exec('PRAGMA journal_mode = WAL;');  // better for many readers + one writer
  db.exec('PRAGMA busy_timeout = 5000;');

  const schema = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  db.exec(schema);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialised - call initDb() first');
  return db;
}

// Runs fn() inside a transaction. If fn throws, everything is rolled back.
// BEGIN IMMEDIATE takes the write lock straight away, so the
// "read version -> check -> update" steps can't interleave with another writer.
function transaction(fn) {
  const conn = getDb();
  conn.exec('BEGIN IMMEDIATE');
  try {
    const result = fn(conn);
    conn.exec('COMMIT');
    return result;
  } catch (err) {
    conn.exec('ROLLBACK');
    throw err;
  }
}

function closeDb() {
  if (db) db.close();
  db = null;
}

// tiny helper: ISO timestamp for updated_at / deleted_at columns
const now = () => new Date().toISOString();

module.exports = { initDb, getDb, transaction, closeDb, now };

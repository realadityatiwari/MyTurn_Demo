/* MyTurn — SQLite persistence (Node built-in `node:sqlite`, zero dependencies).
   One database file holds: the authoritative shared queue snapshot (one row), a schema-migration log,
   and processed Telegram update ids (so duplicate deliveries stay idempotent across restarts).
   Single application instance only (SQLite + one writer). WAL mode, synchronous=FULL, one transaction per save. */
'use strict';
const fs = require('fs'), path = require('path');

class DbError extends Error { constructor(code, message) { super(message); this.code = code; } }

// Versioned, append-only migrations. Never edit an applied migration; add a new one.
const MIGRATIONS = [
  { version: 1, sql: `
    CREATE TABLE app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rev INTEGER NOT NULL,
      epoch INTEGER NOT NULL,
      shared TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE tg_updates (
      update_id INTEGER PRIMARY KEY,
      seen_at TEXT NOT NULL
    );` }
];

// Refuse to start on a snapshot that does not look like MyTurn state (never "repair" by overwriting it).
function validateShared(sh) {
  const bad = why => { throw new DbError('DB_CORRUPT_STATE', 'Stored queue state is invalid (' + why + '). The database was NOT modified. Restore from a backup or inspect it manually.'); };
  if (!sh || typeof sh !== 'object') bad('not an object');
  if (!sh.accounts || typeof sh.accounts !== 'object') bad('accounts');
  if (!sh.q || typeof sh.q !== 'object') bad('queues');
  for (const k in sh.q) {
    if (!Array.isArray(sh.q[k])) bad('queue ' + k);
    for (const e of sh.q[k]) if (!e || typeof e.id !== 'string' || typeof e.tok !== 'string' || typeof e.st !== 'string') bad('entry in ' + k);
  }
  if (!sh.ctr || typeof sh.ctr !== 'object') bad('counters');
  for (const k in sh.ctr) if (!Number.isInteger(sh.ctr[k]) || sh.ctr[k] < 1) bad('counter ' + k);
  if (!Array.isArray(sh.audit)) bad('audit');
  if (!sh.policy || typeof sh.policy !== 'object') bad('policy');
  if (typeof sh.scenario !== 'string') bad('scenario');
  return sh;
}

/* opts.noCreateDir (production): never create the parent directory. If the persistent volume is not mounted the directory is
   missing and we must stop, not silently create an ephemeral folder on the container's disk and lose data on the next deploy. */
function open(file, opts) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); }
  catch (e) { throw new DbError('DB_UNSUPPORTED', 'This Node.js has no built-in SQLite (node:sqlite). Use Node 22.13+ / 24.'); }
  if (file !== ':memory:') {
    const dir = path.dirname(path.resolve(file));
    if (opts && opts.noCreateDir) { if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new DbError('DB_DIR_MISSING', 'The database directory "' + dir + '" does not exist. Is the persistent volume mounted? Refusing to create it.'); }
    else fs.mkdirSync(dir, { recursive: true });
  }
  let db;
  try {
    db = new DatabaseSync(file);
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    const ic = db.prepare('PRAGMA integrity_check').get();
    if (!ic || Object.values(ic)[0] !== 'ok') throw new Error('integrity_check failed');
    db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)');
  } catch (e) {
    try { db && db.close(); } catch (x) { /* ignore */ }
    throw new DbError('DB_OPEN_FAILED', 'Cannot open the database file "' + path.basename(file) + '": ' + e.message);
  }

  // ---- migrations (each in its own transaction) ----
  const applied = new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
  const maxKnown = Math.max(...MIGRATIONS.map(m => m.version));
  for (const v of applied) if (v > maxKnown) { db.close(); throw new DbError('DB_NEWER_SCHEMA', 'Database schema version ' + v + ' is newer than this application supports (' + maxKnown + '). Refusing to start.'); }
  for (const m of MIGRATIONS) {
    if (applied.has(m.version)) continue;
    db.exec('BEGIN IMMEDIATE');
    try { db.exec(m.sql); db.prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)').run(m.version, new Date().toISOString()); db.exec('COMMIT'); }
    catch (e) { db.exec('ROLLBACK'); db.close(); throw new DbError('DB_MIGRATION_FAILED', 'Migration ' + m.version + ' failed: ' + e.message); }
  }

  const q = {
    load: db.prepare('SELECT rev, epoch, shared FROM app_state WHERE id = 1'),
    save: db.prepare('INSERT INTO app_state (id, rev, epoch, shared, updated_at) VALUES (1, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev, epoch = excluded.epoch, shared = excluded.shared, updated_at = excluded.updated_at'),
    seen: db.prepare('SELECT 1 AS x FROM tg_updates WHERE update_id = ?'),
    unmark: db.prepare('DELETE FROM tg_updates WHERE update_id = ?'),
    mark: db.prepare('INSERT OR IGNORE INTO tg_updates (update_id, seen_at) VALUES (?, ?)'),
    prune: db.prepare('DELETE FROM tg_updates WHERE update_id < (SELECT MAX(update_id) FROM tg_updates) - 5000'),
    ping: db.prepare('SELECT 1 AS ok')
  };

  return {
    file,
    /** @returns {null | {rev:number, epoch:number, shared:object}} */
    load() {
      const r = q.load.get(); if (!r) return null;
      let shared; try { shared = JSON.parse(r.shared); } catch (e) { throw new DbError('DB_CORRUPT_STATE', 'Stored queue state is not valid JSON. The database was NOT modified.'); }
      if (!Number.isInteger(r.rev) || !Number.isInteger(r.epoch)) throw new DbError('DB_CORRUPT_STATE', 'Stored revision is invalid. The database was NOT modified.');
      return { rev: r.rev, epoch: r.epoch, shared: validateShared(shared) };
    },
    /** One transaction; throws on failure (caller rolls the in-memory change back).
        claimId (optional): a Telegram update id recorded as processed IN THE SAME TRANSACTION as the queue change, so a crash can never leave
        an update marked processed without its change (or the change without the mark). */
    save({ rev, epoch, shared }, claimId) {
      const json = JSON.stringify(shared);
      db.exec('BEGIN IMMEDIATE');
      try {
        q.save.run(rev, epoch, json, new Date().toISOString());
        if (claimId != null) { q.mark.run(claimId, new Date().toISOString()); if (claimId % 200 === 0) q.prune.run(); }
        db.exec('COMMIT');
      }
      catch (e) { try { db.exec('ROLLBACK'); } catch (x) { /* ignore */ } throw e; }
    },
    /** @returns {boolean} true if this update id was already processed (read-only check). */
    isProcessed(id) { return q.seen.get(id) !== undefined; },
    /** @returns {boolean} true the first time an update id is seen, false for a duplicate delivery. */
    unmarkUpdate(id) { q.unmark.run(id); },            // release a claim when processing failed, so Telegram's retry is processed (not dropped as a duplicate)
    markUpdate(id) {
      const r = q.mark.run(id, new Date().toISOString());
      if (r.changes === 1 && id % 200 === 0) q.prune.run();
      return r.changes === 1;
    },
    check() { return q.ping.get().ok === 1; },
    /** Consistent online backup of the whole database into a new file (refuses to overwrite). */
    backupTo(dest) {
      const d = path.resolve(dest);
      if (fs.existsSync(d)) throw new DbError('BACKUP_EXISTS', 'Backup destination already exists: ' + path.basename(d));
      fs.mkdirSync(path.dirname(d), { recursive: true });
      db.exec("VACUUM INTO '" + d.replace(/'/g, "''") + "'");
      return d;
    },
    close() { try { db.close(); } catch (e) { /* already closed */ } }
  };
}

module.exports = { open, DbError, MIGRATIONS, validateShared };

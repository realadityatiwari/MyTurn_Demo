/* MyTurn — SQLite backup, verification and restore (zero dependencies).
     node server/backup.js backup  <dest.db>            consistent ONLINE backup of DATABASE_PATH (safe while the app is running)
     node server/backup.js verify  <backup.db>          integrity + schema + state check of a backup (read-only)
     node server/backup.js restore <backup.db> --yes    install a verified backup as DATABASE_PATH (the app MUST be stopped)
   Online backup uses SQLite's own VACUUM INTO from a separate connection: a transactionally consistent snapshot, never a raw copy of the
   live file (copying a WAL database while it is being written can produce a corrupt or inconsistent file).
   Restore never deletes anything: the current database (and its -wal/-shm) is moved aside as <db>.pre-restore-<timestamp>*.
   A backup contains patient names, tokens and Telegram ids: store it privately and encrypted; it is created with owner-only permissions.
   A backup is only "known good" after `verify` passes AND a restore has been rehearsed (see DEPLOYMENT.md). */
'use strict';
const fs = require('fs'), path = require('path');
const { MIGRATIONS, validateShared, DbError } = require('./db');

const sqlite = () => { try { return require('node:sqlite').DatabaseSync; } catch (e) { throw new DbError('DB_UNSUPPORTED', 'This Node.js has no built-in SQLite (node:sqlite). Use Node 22.13+ / 24.'); } };
const q = s => "'" + String(s).replace(/'/g, "''") + "'";
const stamp = () => new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');

/** Is another process (e.g. the running app) holding this database open? Detected by trying to take an exclusive lock. */
function inUse(file) {
  if (!fs.existsSync(file)) return false;
  const DatabaseSync = sqlite(); let d;
  try { d = new DatabaseSync(file); d.exec('PRAGMA locking_mode = EXCLUSIVE'); d.exec('BEGIN EXCLUSIVE'); d.exec('COMMIT'); return false; }
  catch (e) { return /locked|busy/i.test(e.message); }
  finally { try { d && d.close(); } catch (e) { /* ignore */ } }
}

/** Read-only verification. Returns a summary WITHOUT personal data; throws DbError on any problem. */
function verify(file) {
  const bad = (code, m) => { throw new DbError(code, m); };
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) bad('BACKUP_MISSING', 'Backup file not found.');
  const DatabaseSync = sqlite(); let d;
  try { d = new DatabaseSync(file, { readOnly: true }); }
  catch (e) { bad('BACKUP_INVALID', 'Not a readable SQLite database: ' + e.message); }
  try {
    let ic; try { ic = d.prepare('PRAGMA integrity_check').get(); } catch (e) { bad('BACKUP_INVALID', 'Not a readable SQLite database: ' + e.message); }
    if (!ic || Object.values(ic)[0] !== 'ok') bad('BACKUP_INVALID', 'SQLite integrity_check failed.');
    const tables = new Set(d.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(r => r.name));
    for (const t of ['app_state', 'tg_updates', 'schema_migrations']) if (!tables.has(t)) bad('BACKUP_INVALID', 'Not a MyTurn database (missing table ' + t + ').');
    const versions = d.prepare('SELECT version FROM schema_migrations').all().map(r => r.version), known = Math.max(...MIGRATIONS.map(m => m.version));
    if (!versions.length || versions.some(v => v > known)) bad('BACKUP_NEWER_SCHEMA', 'Backup schema version ' + Math.max(0, ...versions) + ' is newer than this application supports (' + known + '). Use the matching application version.');
    const r = d.prepare('SELECT rev, epoch, shared FROM app_state WHERE id = 1').get();
    if (!r) bad('BACKUP_INVALID', 'Backup has no queue state.');
    let shared; try { shared = JSON.parse(r.shared); } catch (e) { bad('BACKUP_INVALID', 'Stored queue state is not valid JSON.'); }
    try { validateShared(shared); } catch (e) { bad('BACKUP_INVALID', e.message); }
    let visits = 0; for (const k in shared.q) visits += shared.q[k].length;
    return { schema: Math.max(...versions), rev: r.rev, epoch: r.epoch, visits, accounts: Object.keys(shared.accounts).length, bytes: fs.statSync(file).size };
  } finally { try { d.close(); } catch (e) { /* ignore */ } }
}

/** Online backup of a live (or idle) database into a NEW file. Refuses to overwrite. Verifies the result before reporting success. */
function backup(file, dest) {
  if (!fs.existsSync(file)) throw new DbError('DB_MISSING', 'Database file not found: ' + file);
  let d = path.resolve(dest);
  // A directory (trailing slash, existing directory, or a name with no file extension such as /data/backups) = timestamped file inside it.
  // (Found in the container rehearsal: "backup /data/backups" used to create a FILE called "backups".)
  if (/[\\/]$/.test(dest) || (fs.existsSync(d) && fs.statSync(d).isDirectory()) || (!path.extname(d) && !fs.existsSync(d))) d = path.join(d, 'myturn-' + stamp() + '.db');
  if (fs.existsSync(d)) throw new DbError('BACKUP_EXISTS', 'Backup destination already exists: ' + path.basename(d) + ' (backups are never overwritten).');
  fs.mkdirSync(path.dirname(d), { recursive: true });
  const DatabaseSync = sqlite(), db = new DatabaseSync(file);
  try { db.exec('PRAGMA busy_timeout = 10000'); db.exec('VACUUM INTO ' + q(d)); }
  catch (e) { try { fs.rmSync(d, { force: true }); } catch (x) { /* ignore */ } throw new DbError('BACKUP_FAILED', 'Backup failed: ' + e.message); }
  finally { try { db.close(); } catch (e) { /* ignore */ } }
  try { fs.chmodSync(d, 0o600); } catch (e) { /* not supported on this OS */ }
  try { return Object.assign({ file: d }, verify(d)); }
  catch (e) { try { fs.rmSync(d, { force: true }); } catch (x) { /* ignore */ } throw new DbError('BACKUP_FAILED', 'Backup was written but did not verify (' + e.message + '); it was removed.'); }
}

/** Offline restore. Verifies first, refuses while the database is in use, moves the current files aside, installs atomically. */
function restore(backupFile, target, o) {
  o = o || {};
  const info = verify(backupFile);
  if (!o.confirm) throw new DbError('RESTORE_NOT_CONFIRMED', 'Restore not confirmed (pass --yes). Backup is valid: ' + info.visits + ' visits, schema ' + info.schema + '.');
  const t = path.resolve(target);
  if (path.resolve(backupFile) === t) throw new DbError('RESTORE_SAME_FILE', 'The backup and the target are the same file.');
  if (!fs.existsSync(path.dirname(t))) throw new DbError('DB_DIR_MISSING', 'Target directory does not exist (is the volume mounted?): ' + path.dirname(t));
  if (inUse(t)) throw new DbError('DB_IN_USE', 'The database is open in another process (is the app still running?). Stop the app first. Nothing was changed.');
  let aside = t + '.pre-restore-' + stamp();
  for (let n = 1; ['', '-wal', '-shm'].some(x => fs.existsSync(aside + x)); n++) aside = t + '.pre-restore-' + stamp() + '-' + n;   // never overwrite an earlier safety copy
  const tmp = t + '.restore-tmp', moved = [];
  try {
    fs.copyFileSync(backupFile, tmp, fs.constants.COPYFILE_EXCL);
    const fd = fs.openSync(tmp, 'r+'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    verify(tmp);                                                // the copy itself must verify, not just the source
    for (const ext of ['', '-wal', '-shm']) if (fs.existsSync(t + ext)) { fs.renameSync(t + ext, aside + ext); moved.push(ext); }   // stale -wal/-shm must never sit next to the restored file
    fs.renameSync(tmp, t);
    try { fs.chmodSync(t, 0o600); } catch (e) { /* ignore */ }
    return Object.assign({ restored: t, previous: moved.length ? aside : null }, verify(t));
  } catch (e) {
    for (const ext of moved) { try { fs.renameSync(aside + ext, t + ext); } catch (x) { /* best effort */ } }   // put the old database back
    try { fs.rmSync(tmp, { force: true }); } catch (x) { /* ignore */ }
    throw e instanceof DbError ? e : new DbError('RESTORE_FAILED', 'Restore failed and was rolled back: ' + e.message);
  }
}

module.exports = { backup, verify, restore, inUse };

if (require.main === module) {
  const { loadEnv } = require('./server');
  loadEnv(path.join(__dirname, '..', '.env'));
  const [cmd, arg, flag] = process.argv.slice(2);
  // Production tooling never guesses a path: acting on the wrong file (e.g. a default under /app) must be impossible.
  if (process.env.NODE_ENV === 'production' && (!process.env.DATABASE_PATH || process.env.DATABASE_PATH === 'memory')) { console.error('Error [NO_DATABASE_PATH]: DATABASE_PATH is not set in this shell. Set it explicitly (e.g. DATABASE_PATH=/data/myturn.db).'); process.exit(1); }
  const dbFile = process.env.DATABASE_PATH && process.env.DATABASE_PATH !== 'memory' ? process.env.DATABASE_PATH : path.join(__dirname, 'data', 'myturn.db');
  const usage = () => { console.error('usage: node server/backup.js backup <dest.db> | verify <backup.db> | restore <backup.db> --yes'); process.exit(2); };
  try {
    if (!arg) usage();
    if (cmd === 'backup') { const r = backup(dbFile, arg); console.log('Backup written and verified: ' + r.file + '\n  schema ' + r.schema + ', revision ' + r.rev + ', ' + r.visits + ' visits, ' + r.bytes + ' bytes\n  It contains personal data: keep it private/encrypted. It is not "recoverable" until a restore has been rehearsed.'); }
    else if (cmd === 'verify') { const r = verify(arg); console.log('Backup is valid: schema ' + r.schema + ', revision ' + r.rev + ', ' + r.visits + ' visits, ' + r.accounts + ' accounts, ' + r.bytes + ' bytes'); }
    else if (cmd === 'restore') { const r = restore(arg, dbFile, { confirm: flag === '--yes' }); console.log('Restored ' + r.visits + ' visits into ' + r.restored + '\n  Previous database kept at: ' + (r.previous || '(there was none)') + '\n  Start the app and check /healthz.'); }
    else usage();
  } catch (e) { console.error('Error [' + (e.code || 'ERROR') + ']: ' + e.message); process.exit(1); }
}

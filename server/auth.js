/* MyTurn — server-side authentication helpers (zero dependencies, Node crypto only).
   - scrypt password hashes ("scrypt$N$r$p$salt$hash", base64) with timing-safe comparison
   - opaque random session ids; only a SHA-256 of the id is kept server-side
   - separate STAFF and PATIENT sessions (two cookies) so a sign-in never inherits another sign-in's state
   - login throttling per IP, per IP+user and per user
   Staff passwords are configured as hashes in environment variables; this file never logs or returns secrets. */
'use strict';
const crypto = require('crypto');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
const scryptAsync = (pw, salt, n, r, p, len) => new Promise((res, rej) =>
  crypto.scrypt(pw, salt, len, { N: n, r, p, maxmem: 256 * n * r + 1024 * 1024 }, (e, k) => e ? rej(e) : res(k)));

async function hashPassword(pw) {
  const salt = crypto.randomBytes(16), { N, r, p, keylen } = SCRYPT;
  const key = await scryptAsync(String(pw), salt, N, r, p, keylen);
  return ['scrypt', N, r, p, salt.toString('base64'), key.toString('base64')].join('$');
}
function parseHash(stored) {
  const m = typeof stored === 'string' && stored.match(/^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  const N = +m[1], r = +m[2], p = +m[3];
  if (N < 1024 || N > 131072 || (N & (N - 1)) || r < 1 || r > 16 || p < 1 || p > 4) return null;   // bounded: a bad config cannot be used to exhaust memory
  return { N, r, p, salt: Buffer.from(m[4], 'base64'), key: Buffer.from(m[5], 'base64') };
}
async function verifyPassword(pw, stored) {
  const h = parseHash(stored); if (!h || typeof pw !== 'string') return false;
  const key = await scryptAsync(pw, h.salt, h.N, h.r, h.p, h.key.length);
  return key.length === h.key.length && crypto.timingSafeEqual(key, h.key);
}

// ---- cookies ----
function parseCookies(header) {
  const out = {}; if (typeof header !== 'string') return out;
  for (const part of header.split(';')) { const i = part.indexOf('='); if (i > 0) { const k = part.slice(0, i).trim(); if (!(k in out)) out[k] = part.slice(i + 1).trim(); } }
  return out;
}
function cookie(name, value, { maxAge, secure }) {
  return name + '=' + value + '; Path=/; HttpOnly; SameSite=Strict' + (secure ? '; Secure' : '') + '; Max-Age=' + Math.max(0, Math.floor(maxAge));
}

// ---- sessions ----
class Sessions {
  constructor({ idleMs, absMs, max = 5000, now = Date.now }) { Object.assign(this, { idleMs, absMs, max, now }); this.map = new Map(); }
  static key(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
  create(data) {                                     // always a NEW id: a presented/pre-set id is never adopted (session fixation)
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    const token = crypto.randomBytes(32).toString('base64url'), t = this.now();
    this.map.set(Sessions.key(token), { data, created: t, last: t });
    return token;
  }
  get(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const k = Sessions.key(token), s = this.map.get(k), t = this.now();
    if (!s) return null;
    if (t - s.last > this.idleMs || t - s.created > this.absMs) { this.map.delete(k); return null; }
    s.last = t; return s.data;
  }
  peek(token) {                                      // validity check WITHOUT extending the idle timer (used by open event streams)
    if (typeof token !== 'string' || token.length < 20 || token.length > 100) return null;
    const k = Sessions.key(token), s = this.map.get(k), t = this.now();
    if (!s) return null;
    if (t - s.last > this.idleMs || t - s.created > this.absMs) { this.map.delete(k); return null; }
    return s.data;
  }
  destroy(token) { if (typeof token === 'string') this.map.delete(Sessions.key(token)); }
  clear() { this.map.clear(); }
}

// ---- login throttling ----
class Throttle {
  constructor({ now = Date.now, limits } = {}) {
    this.now = now; this.m = new Map();
    // [max failures, window = first lock duration]. Deliberately NO global per-username lock: it would let anyone (or a botnet) lock every
    // staff member out by guessing wrong passwords. A guesser is limited per client IP instead; passwords must be 12+ random characters.
    this.limits = limits || { ipUser: [5, 15 * 60e3], ip: [20, 15 * 60e3] };
  }
  keys(ip, user) { return { ipUser: 'iu|' + ip + '|' + user, ip: 'i|' + ip }; }
  retryAfter(ip, user) {                                // seconds until another attempt is allowed (0 = allowed)
    const t = this.now(); let wait = 0;
    for (const k of Object.values(this.keys(ip, user))) { const e = this.m.get(k); if (e && e.lock > t) wait = Math.max(wait, e.lock - t); }
    return Math.ceil(wait / 1000);
  }
  fail(ip, user) {
    const t = this.now(), ks = this.keys(ip, user);
    for (const scope of Object.keys(ks)) {
      const [max, win] = this.limits[scope]; let e = this.m.get(ks[scope]);
      if (!e || t - e.first > win * 4) e = { n: 0, first: t, lock: 0, lv: e ? e.lv : 0 };
      e.n++; if (e.n >= max) { e.lock = t + Math.min(win * Math.pow(2, e.lv), 60 * 60e3); e.lv++; e.n = 0; e.first = t; }   // lock, doubling each time up to 1 h
      this.m.set(ks[scope], e);
    }
    if (this.m.size > 20000) for (const [k, e] of this.m) if (e.lock < t && t - e.first > 3600e3) this.m.delete(k);
  }
  ok(ip, user) { this.m.delete(this.keys(ip, user).ipUser); }
}

// ---- fixed-window rate limiter: allow(key, max, windowMs) -> 0 when allowed, else seconds to wait ----
class RateLimiter {
  constructor({ now = Date.now } = {}) { this.now = now; this.m = new Map(); }
  allow(key, max, windowMs) {
    const t = this.now(); let e = this.m.get(key);
    if (!e || t - e.start >= windowMs) { e = { start: t, n: 0 }; this.m.set(key, e); }
    if (e.n >= max) return Math.max(1, Math.ceil((e.start + windowMs - t) / 1000));
    e.n++;
    if (this.m.size > 20000) for (const [k, v] of this.m) if (t - v.start > 3600e3) this.m.delete(k);
    return 0;
  }
}
/* ---- client identity behind a reverse proxy ----
   A forwarded-IP header is only believable when the TCP peer is the proxy. "Trusted peers" default to private/loopback ranges and can be
   NARROWED with TRUSTED_PROXY_CIDRS (e.g. to the exact internal range of the platform proxy once it has been observed).
   cf-connecting-ip is the single-IP header Cloudflare sets for Render's edge (Render fronts every web service with Cloudflare); it is accepted
   only from a trusted proxy peer and must be one IP, never a chain. fly-client-ip is the equivalent header on Fly.io.
   resolveClient() never trusts a header from an untrusted peer and never invents an identity: when identity cannot be established it says so
   (trusted=false) so callers can refuse sensitive operations instead of putting everybody into one shared bucket. */
const net = require('net');
const DEFAULT_TRUSTED_PEERS = ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '127.0.0.0/8', 'fc00::/7', '::1/128'];
const normalizeIp = s => {                                       // '::ffff:1.2.3.4' -> '1.2.3.4'; strips an IPv6 zone; null when not an IP literal
  let v = String(s == null ? '' : s).trim(); if (v.length > 64) return null;
  v = v.replace(/%[^%]*$/, '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i, '$1');
  return net.isIP(v) ? v.toLowerCase() : null;
};
function parseCidrs(list) {                                      // -> { list: net.BlockList, bad: [strings] }
  const bl = new net.BlockList(), bad = [];
  for (const c of list) {
    const m = String(c).trim().match(/^([0-9a-f:.]+)\/(\d{1,3})$/i), ip = m && normalizeIp(m[1]);
    const v6 = ip && net.isIPv6(ip), max = v6 ? 128 : 32;
    if (!m || !ip || +m[2] > max) { bad.push(String(c).trim()); continue; }
    try { bl.addSubnet(ip, +m[2], v6 ? 'ipv6' : 'ipv4'); } catch (e) { bad.push(String(c).trim()); }
  }
  return { list: bl, bad };
}
const DEFAULT_TRUST = parseCidrs(DEFAULT_TRUSTED_PEERS).list;
const isTrustedPeer = (peer, trust) => { const ip = normalizeIp(peer); return !!ip && (trust || DEFAULT_TRUST).check(ip, net.isIPv6(ip) ? 'ipv6' : 'ipv4'); };
const isPrivateAddr = a => isTrustedPeer(a, DEFAULT_TRUST);
/** @returns {{ip: string|null, trusted: boolean, reason: string}} reason: direct | proxy | peer-not-trusted | header-missing | header-invalid */
function resolveClient({ peer, headers, proxyHeader, trust }) {
  const peerIp = normalizeIp(peer);
  if (!proxyHeader) return peerIp ? { ip: peerIp, trusted: true, reason: 'direct' } : { ip: null, trusted: false, reason: 'peer-unknown' };   // no proxy configured: the TCP peer IS the client
  if (!peerIp || !isTrustedPeer(peerIp, trust)) return { ip: null, trusted: false, reason: 'peer-not-trusted' };                                 // header from an untrusted peer is ignored entirely
  let raw = headers && headers[proxyHeader];
  if (Array.isArray(raw)) {                                       // duplicate header fields are not a valid single-IP identity
    if (proxyHeader === 'cf-connecting-ip') return { ip: null, trusted: false, reason: 'header-invalid' };
    raw = raw[raw.length - 1];
  }
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ip: null, trusted: false, reason: 'header-missing' };
  const value = String(raw).trim();
  if (proxyHeader === 'cf-connecting-ip' && value.includes(',')) return { ip: null, trusted: false, reason: 'header-invalid' };
  const hop = proxyHeader === 'cf-connecting-ip' ? value : value.split(',').pop().trim();   // XFF: the LAST hop is the one the trusted proxy itself appended; earlier entries are client-supplied
  const ip = normalizeIp(hop);
  return ip ? { ip, trusted: true, reason: 'proxy' } : { ip: null, trusted: false, reason: 'header-invalid' };
}

// ---- configuration (from environment; injectable for tests) ----
const DEMO_PASSWORD = 'demo';                           // local development ONLY (labelled in the UI as demo credentials)
function authConfig(env) {
  env = env || process.env;
  const production = env.NODE_ENV === 'production';
  const users = {};
  for (const [name, key] of [['operator', 'STAFF_OPERATOR_PASSWORD_HASH'], ['admin', 'STAFF_ADMIN_PASSWORD_HASH']]) {
    if (env[key]) users[name] = { role: name === 'admin' ? 'admin' : 'op', hash: env[key] };
  }
  const warnings = [];
  for (const [n, u] of Object.entries(users)) if (!parseHash(u.hash)) { warnings.push(n + ' password hash is malformed; that account is disabled.'); delete users[n]; }
  const demoCredentials = !production && !Object.keys(users).length;     // only when NO real hash is configured, and never in production
  const patientWeb = env.PATIENT_WEB_MODE === 'demo' || env.PATIENT_WEB_MODE === 'disabled' ? env.PATIENT_WEB_MODE : (production ? 'disabled' : 'demo');
  let openControls = env.DEMO_OPEN_CONTROLS === '1';
  if (openControls && production) { openControls = false; warnings.push('DEMO_OPEN_CONTROLS is ignored in production.'); }
  const proxyHeader = env.TRUST_PROXY_HEADER ? String(env.TRUST_PROXY_HEADER).toLowerCase() : null;
  const publicOrigin = env.PUBLIC_ORIGIN ? String(env.PUBLIC_ORIGIN).replace(/\/+$/, '') : null;
  return { production, users, demoCredentials, patientWeb, openControls, publicOrigin,
    allowReset: !production || env.ALLOW_PRODUCTION_RESET === '1',
    secureCookie: production || env.COOKIE_SECURE === '1',
    proxyHeader, warnings,
    trustedProxyCidrs: env.TRUSTED_PROXY_CIDRS ? String(env.TRUSTED_PROXY_CIDRS).split(',').map(s => s.trim()).filter(Boolean) : null,   // null = default private/loopback ranges
    // requests per window; override in tests / for tuning
    rate: { ip: [300, 60e3], session: [120, 60e3], patientSession: [60, 60e3], destructive: [5, 60e3], signIn: [20, 600e3], login: [60, 60e3], sse: [10, 1e9], webhook: [600, 60e3], ipUnidentified: [3000, 60e3] } };
}

// Telegram's secret_token rule: 1-256 chars of A-Z a-z 0-9 _ - ; we additionally require 32+ so it cannot be guessed.
const validWebhookSecret = s => typeof s === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(s);
const safeEqual = (a, b) => { const h = x => crypto.createHash('sha256').update(String(x == null ? '' : x)).digest(); return typeof a === 'string' && typeof b === 'string' && crypto.timingSafeEqual(h(a), h(b)); };

/* Unsafe production configuration is refused at startup (fail closed) rather than degraded silently. */
function productionErrors(cfg, env) {
  env = env || process.env; const errs = [];
  if (!cfg.production) return errs;
  if (!cfg.publicOrigin || !/^https:\/\/[a-z0-9.-]+(:\d+)?$/i.test(cfg.publicOrigin)) errs.push('PUBLIC_ORIGIN must be set to the public https origin (e.g. https://example.fly.dev).');
  if (!Object.keys(cfg.users).length) errs.push('No valid staff password hash: set STAFF_OPERATOR_PASSWORD_HASH and/or STAFF_ADMIN_PASSWORD_HASH (see server/hash-password.js).');
  if (cfg.demoCredentials) errs.push('Demo credentials cannot be enabled in production.');
  if (!cfg.secureCookie) errs.push('Cookies must be Secure in production.');
  if (cfg.openControls) errs.push('Open presenter controls cannot be enabled in production.');
  if (!env.DATABASE_PATH) errs.push('DATABASE_PATH must be set explicitly to a file on the persistent volume (no default path in production).');
  if (env.DATABASE_PATH === 'memory') errs.push('DATABASE_PATH=memory (no persistence) is not allowed in production.');
  if (env.SEED_MODE === 'demo') errs.push('SEED_MODE=demo (sample patients) is not allowed in production; production always starts empty.');
  if (cfg.patientWeb === 'demo') errs.push('PATIENT_WEB_MODE=demo (simulated patient sign-in) is not allowed in production.');
  if (env.TELEGRAM_API_BASE && env.TELEGRAM_API_BASE !== 'https://api.telegram.org') errs.push('TELEGRAM_API_BASE must be unset in production (the bot token would be sent to that host).');
  if (env.PORT !== undefined && env.PORT !== '' && !(Number.isInteger(Number(env.PORT)) && Number(env.PORT) > 0 && Number(env.PORT) < 65536)) errs.push('PORT must be an integer from 1 to 65535.');
  if (cfg.proxyHeader && !['x-forwarded-for', 'fly-client-ip', 'cf-connecting-ip'].includes(cfg.proxyHeader)) errs.push('TRUST_PROXY_HEADER must be x-forwarded-for, fly-client-ip or cf-connecting-ip.');
  if (cfg.trustedProxyCidrs && parseCidrs(cfg.trustedProxyCidrs).bad.length) errs.push('TRUSTED_PROXY_CIDRS contains an invalid entry (expected comma-separated CIDRs such as 172.16.0.0/12).');
  if (cfg.trustedProxyCidrs && !cfg.proxyHeader) errs.push('TRUSTED_PROXY_CIDRS only makes sense together with TRUST_PROXY_HEADER.');
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_MODE !== 'webhook') errs.push('With a Telegram bot token, production requires TELEGRAM_MODE=webhook (long polling is for local development only).');
  if (env.TELEGRAM_MODE === 'webhook' && !validWebhookSecret(env.TELEGRAM_WEBHOOK_SECRET)) errs.push('TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_SECRET: 32-256 characters from A-Z a-z 0-9 _ - (generate a random one).');
  return errs;
}

module.exports = { hashPassword, verifyPassword, parseHash, parseCookies, cookie, Sessions, Throttle, RateLimiter, isPrivateAddr, isTrustedPeer, resolveClient, parseCidrs, normalizeIp, authConfig, productionErrors, validWebhookSecret, safeEqual, DEMO_PASSWORD };

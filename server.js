require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const dns = require('dns').promises;
const net = require('net');
const { Pool } = require('pg');

const app = express();
const server = http.createServer(app);
const APP_ORIGINS = new Set(
  String(process.env.APP_ORIGINS || '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
);

function corsOriginAllowed(origin) {
  if (!origin) return true;
  return APP_ORIGINS.size === 0 || APP_ORIGINS.has(origin);
}

const io = new Server(server, {
  maxHttpBufferSize: 1e5,
  cors: {
    origin: (origin, callback) => {
      if (corsOriginAllowed(origin)) return callback(null, true);
      callback(new Error('CORS origin not allowed'));
    },
    methods: ['GET', 'POST'],
    credentials: true
  }
});

const PORT = Number(process.env.PORT) || 10000;
const DATABASE_URL = process.env.DATABASE_URL;
const DATABASE_SSL = String(process.env.DATABASE_SSL || '').toLowerCase() === 'true';
const DATABASE_CA = typeof process.env.DATABASE_CA === 'string' ? process.env.DATABASE_CA.trim() : '';
const MAX_MESSAGE_LENGTH = 2000;
const MAX_USERNAME_LENGTH = 24;
const MAX_STATUS_LENGTH = 80;
const MAX_AVATAR_URL_LENGTH = 500;
const MAX_USERS = 1000;
const MESSAGE_COOLDOWN_MS = 750;
const ADMIN_USERS = new Set(['DEV', 'testuser1', 'skullfucker99']);

if (!DATABASE_URL) {
  console.error('DATABASE_URL is required. Configure a PostgreSQL database before starting the server.');
  process.exit(1);
}

function buildDatabaseConfig() {
  const parsed = new URL(DATABASE_URL);
  const sslMode = (parsed.searchParams.get('sslmode') || '').toLowerCase();

  // pg replaces the explicit ssl object when sslmode/sslcert/etc. are present
  // in the connection string. Remove sslmode so our TLS settings below take effect.
  parsed.searchParams.delete('sslmode');

  let ssl;
  if (DATABASE_CA) {
    ssl = {
      ca: DATABASE_CA,
      rejectUnauthorized: true
    };
  } else if (DATABASE_SSL || sslMode === 'require') {
    // Aiven's sslmode=require encrypts the connection without requiring a CA.
    // This also handles Aiven's private project CA on hosted environments such as Render.
    ssl = { rejectUnauthorized: false };
    console.warn('DATABASE_CA is not set; PostgreSQL TLS certificate verification is disabled.');
  }

  return {
    connectionString: parsed.toString(),
    ssl,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000
  };
}

let dbConfig;
try {
  dbConfig = buildDatabaseConfig();
} catch (error) {
  console.error('Invalid DATABASE_URL:', error.message);
  process.exit(1);
}

const db = new Pool(dbConfig);

const sessions = new Map();
const onlineUsers = new Map();
let messages = [];
const whispers = [];
const auditLogs = [];
const avatarReports = [];

app.use(express.json({ limit: '100kb' }));

// CORS for API routes. Set APP_ORIGINS to a comma-separated allowlist in Render.
// Example: APP_ORIGINS=https://your-app.onrender.com
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  const isSandboxProxyRequest = req.path === '/render' && origin === 'null';
  if (!corsOriginAllowed(origin) && !isSandboxProxyRequest) {
    return res.status(403).json({ error: 'CORS origin not allowed.' });
  }

  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Private developer preview. Requests are session-keyed and destination allowlisted.
// ---------------------------------------------------------------------------
function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) ||
      a >= 224
    );
  }
  const l = ip.toLowerCase();
  if (l.startsWith('::ffff:')) return isPrivateIp(l.slice(7));
  return l === '::1' || l === '::' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80');
}

const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;
const RENDER_MAX_BYTES = 15 * 1024 * 1024;
const PREVIEW_SESSION_TTL_MS = 15 * 60 * 1000;
const RENDER_RATE_WINDOW_MS = 60 * 1000;
const RENDER_RATE_LIMIT = 120;
const RENDER_MAX_CONCURRENT = 12;
const previewSessions = new Map();

const PREVIEW_ALLOWED_HOSTS = new Set(
  String(process.env.PREVIEW_ALLOWED_HOSTS || '')
    .split(',')
    .map(value => value.trim().toLowerCase())
    .filter(Boolean)
);

function hostAllowed(hostname) {
  const host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!PREVIEW_ALLOWED_HOSTS.size) return false;
  for (const rule of PREVIEW_ALLOWED_HOSTS) {
    const normalized = rule.replace(/^\*\./, '');
    if (rule.startsWith('*.')) {
      if (host === normalized || host.endsWith(`.${normalized}`)) return true;
    } else if (host === normalized) {
      return true;
    }
  }
  return false;
}

async function assertPublicUrl(u) {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('Only http(s) URLs are allowed.');
  if (!hostAllowed(u.hostname)) throw new Error('That website is not enabled for the developer preview.');
  const addrs = await dns.lookup(u.hostname, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new Error('That address is not allowed.');
}

function requireAdminHttp(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const username = token ? sessions.get(token) : null;
  if (!username || !isAdmin(username)) return res.status(403).json({ error: 'Admin login required.' });
  req.username = username;
  next();
}

function createPreviewSession(username) {
  const key = crypto.randomBytes(32).toString('hex');
  previewSessions.set(key, {
    username,
    expiresAt: Date.now() + PREVIEW_SESSION_TTL_MS,
    cookies: new Map(),
    windowStartedAt: Date.now(),
    windowCount: 0,
    active: 0
  });
  return key;
}

function getPreviewSession(key) {
  const session = previewSessions.get(key);
  if (!session) return null;
  if (Date.now() > session.expiresAt) {
    previewSessions.delete(key);
    return null;
  }
  return session;
}

function requirePreviewKey(req, res, next) {
  const key = String(req.query.key || '');
  const session = getPreviewSession(key);
  if (!session) return res.status(403).json({ error: 'Preview session expired. Reload the tester.' });
  req.previewKey = key;
  req.previewSession = session;
  next();
}

function enterRenderRequest(session) {
  const now = Date.now();
  if (now - session.windowStartedAt >= RENDER_RATE_WINDOW_MS) {
    session.windowStartedAt = now;
    session.windowCount = 0;
  }
  if (session.windowCount >= RENDER_RATE_LIMIT) {
    const retryAfter = Math.max(1, Math.ceil((RENDER_RATE_WINDOW_MS - (now - session.windowStartedAt)) / 1000));
    const error = Object.assign(new Error('Too many preview requests. Please wait a moment.'), { statusCode: 429, retryAfter });
    throw error;
  }
  if (session.active >= RENDER_MAX_CONCURRENT) {
    throw Object.assign(new Error('Too many resources are loading at once.'), { statusCode: 429, retryAfter: 2 });
  }
  session.windowCount += 1;
  session.active += 1;
}

function leaveRenderRequest(session) {
  session.active = Math.max(0, session.active - 1);
}

function shouldProxyUrl(value) {
  const v = String(value || '').trim();
  if (!v || v.startsWith('#')) return false;
  return !/^(?:data:|blob:|javascript:|mailto:|tel:|about:)/i.test(v);
}

function htmlEscapeAttribute(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function cssEscapeUrl(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function makeProxyUrl(target, key, proxyOrigin) {
  return `${proxyOrigin}/api/render?key=${encodeURIComponent(key)}&url=${encodeURIComponent(target)}`;
}

function absoluteAndProxy(value, baseUrl, key, proxyOrigin) {
  if (!shouldProxyUrl(value)) return value;
  try {
    const absolute = new URL(String(value).trim(), baseUrl).href;
    if (absolute.startsWith(proxyOrigin + '/api/render')) return absolute;
    return makeProxyUrl(absolute, key, proxyOrigin);
  } catch {
    return value;
  }
}

function rewriteSrcset(value, baseUrl, key, proxyOrigin) {
  return String(value).split(',').map(part => {
    const bits = part.trim().split(/\s+/);
    if (!bits[0]) return part;
    bits[0] = absoluteAndProxy(bits[0], baseUrl, key, proxyOrigin);
    return bits.join(' ');
  }).join(', ');
}

function rewriteCss(css, baseUrl, key, proxyOrigin) {
  let out = String(css);
  out = out.replace(/url\(\s*(['"]?)([^)'"\\]+|data:[^)]*?)\1\s*\)/gi, (full, quote, rawUrl) => {
    const trimmed = String(rawUrl).trim();
    if (!shouldProxyUrl(trimmed)) return full;
    const proxied = absoluteAndProxy(trimmed, baseUrl, key, proxyOrigin);
    return `url(${quote}${cssEscapeUrl(proxied)}${quote})`;
  });
  out = out.replace(/(@import\s+)(['"])([^'"]+)\2/gi, (full, prefix, quote, rawUrl) => {
    if (!shouldProxyUrl(rawUrl)) return full;
    const proxied = absoluteAndProxy(rawUrl, baseUrl, key, proxyOrigin);
    return `${prefix}${quote}${cssEscapeUrl(proxied)}${quote}`;
  });
  return out;
}

function rewriteHtml(html, baseUrl, key, proxyOrigin) {
  let out = String(html);

  // Remove upstream browser policies that refer to the original origin.
  out = out.replace(/<meta[^>]+http-equiv=["']?content-security-policy[^>]*>/gi, '');
  out = out.replace(/<base\b[^>]*>/gi, '');

  const attrPattern = /\b(src|href|action|poster|data)\s*=\s*(["'])(.*?)\2/gi;
  out = out.replace(attrPattern, (full, name, quote, value) => {
    if (!shouldProxyUrl(value)) return full;
    const proxied = absoluteAndProxy(value, baseUrl, key, proxyOrigin);
    return `${name}=${quote}${htmlEscapeAttribute(proxied)}${quote}`;
  });

  out = out.replace(/\b(srcset)\s*=\s*(["'])(.*?)\2/gi, (full, name, quote, value) =>
    `${name}=${quote}${htmlEscapeAttribute(rewriteSrcset(value, baseUrl, key, proxyOrigin))}${quote}`
  );

  out = out.replace(/\bstyle\s*=\s*(["'])(.*?)\1/gi, (full, quote, value) =>
    `style=${quote}${htmlEscapeAttribute(rewriteCss(value, baseUrl, key, proxyOrigin))}${quote}`
  );

  out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (full, open, css, close) =>
    `${open}${rewriteCss(css, baseUrl, key, proxyOrigin)}${close}`
  );

  // SRI hashes can fail when CSS is rewritten, so remove integrity/crossorigin
  // from resource tags whose content or URL may be transformed.
  out = out.replace(/\s+(?:integrity|crossorigin)\s*=\s*(["']).*?\1/gi, '');

  out = out.replace(/(<meta\b[^>]+http-equiv=["']?refresh["']?[^>]*content=["'][^"]*url\s*=\s*)([^"']+)/gi, (full, prefix, value) =>
    prefix + absoluteAndProxy(value.trim(), baseUrl, key, proxyOrigin)
  );

  const baseTag = `<base href="${htmlEscapeAttribute(baseUrl)}">`;
  const runtime = `<script>(function(){
    const K=${JSON.stringify(key).replace(/</g,'\\u003c')};
    const O=${JSON.stringify(proxyOrigin).replace(/</g,'\\u003c')};
    const P=O+'/api/render?key='+encodeURIComponent(K)+'&url=';
    const wrap=v=>{try{const s=String(v??'').trim();if(!s||/^(?:data:|blob:|javascript:|mailto:|tel:|about:|#)/i.test(s))return v;const u=new URL(s,document.baseURI);if(!/^https?:$/i.test(u.protocol)||u.href.startsWith(P))return v;return P+encodeURIComponent(u.href)}catch{return v}};
    const of=window.fetch;if(of)window.fetch=function(input,init){try{if(typeof input==='string'||input instanceof URL)return of.call(this,wrap(input),init);if(input&&input.url){const r=new Request(wrap(input.url),input);return of.call(this,r,init)}}catch{}return of.apply(this,arguments)};
    const xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url){arguments[1]=wrap(url);return xo.apply(this,arguments)};
    const wo=window.open;if(wo)window.open=function(url,target,features){return wo.call(this,wrap(url),target,features)};
  })();</script>`;

  if (/<head\b[^>]*>/i.test(out)) {
    out = out.replace(/<head\b[^>]*>/i, m => `${m}${baseTag}${runtime}`);
  } else {
    out = baseTag + runtime + out;
  }
  return out;
}

async function responseBodyLimited(response, limit) {
  const chunks = [];
  let total = 0;
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw Object.assign(new Error('Upstream response is too large.'), { statusCode: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function storeUpstreamCookies(session, url, response) {
  const getSetCookie = response.headers.getSetCookie;
  if (typeof getSetCookie !== 'function') return;
  const cookies = getSetCookie.call(response.headers);
  if (!cookies.length) return;
  const origin = new URL(url).origin;
  const jar = session.cookies.get(origin) || new Map();
  for (const line of cookies) {
    const pair = String(line).split(';', 1)[0].trim();
    const eq = pair.indexOf('=');
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    if (!value) jar.delete(name);
    else jar.set(name, value);
  }
  session.cookies.set(origin, jar);
}

function cookieHeaderFor(session, url) {
  const jar = session.cookies.get(new URL(url).origin);
  if (!jar) return '';
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

function proxyOriginFor(req) {
  const host = req.get('host');
  const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
  return `${proto.split(',')[0].trim()}://${host}`;
}

function upstreamHeaders(req, cookieHeader, targetUrl) {
  const target = new URL(targetUrl);
  const headers = {
    'user-agent': req.get('user-agent') || 'Mozilla/5.0',
    'accept': req.get('accept') || '*/*',
    'accept-language': req.get('accept-language') || 'en-US,en;q=0.8'
  };
  const contentType = req.get('content-type');
  if (contentType) headers['content-type'] = contentType;
  if (cookieHeader) headers.cookie = cookieHeader;

  // Preserve same-site navigation context without forwarding the proxy's own origin.
  const referer = req.get('referer');
  if (referer) {
    try {
      const ref = new URL(referer);
      if (ref.origin === proxyOriginFor(req)) headers.referer = target.origin + '/';
    } catch {}
  }
  return headers;
}

async function fetchThroughProxy(req, targetUrl, session) {
  let current = new URL(targetUrl);
  let method = String(req.method || 'GET').toUpperCase();
  let body = !['GET', 'HEAD'].includes(method) && Buffer.isBuffer(req.body) ? req.body : undefined;
  let response;

  for (let hop = 0; hop <= 8; hop++) {
    await assertPublicUrl(current);
    const headers = upstreamHeaders(req, cookieHeaderFor(session, current.href), current.href);
    response = await fetch(current, {
      method,
      body,
      redirect: 'manual',
      signal: AbortSignal.timeout(15000),
      headers
    });
    storeUpstreamCookies(session, current.href, response);

    const loc = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && loc) {
      if (hop === 8) throw Object.assign(new Error('Too many redirects.'), { statusCode: 502 });
      const next = new URL(loc, current);
      if ([301, 302, 303].includes(response.status) && !['GET', 'HEAD'].includes(method)) {
        method = 'GET';
        body = undefined;
      }
      current = next;
      continue;
    }
    break;
  }
  return { response, finalUrl: current.href };
}

app.get('/api/preview-key', requireAdminHttp, (req, res) => {
  const key = createPreviewSession(req.username);
  res.set('Cache-Control', 'no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
  res.json({ key, expiresInMs: PREVIEW_SESSION_TTL_MS });
});

app.all('/api/render', requirePreviewKey, express.raw({ type: '*/*', limit: '5mb' }), async (req, res) => {
  const session = req.previewSession;
  let requestEntered = false;
  try {
    enterRenderRequest(session);
    requestEntered = true;

    let target;
    try { target = new URL(String(req.query.url || '')); }
    catch { return res.status(400).json({ error: 'Invalid URL.' }); }

    const started = Date.now();
    const { response, finalUrl } = await fetchThroughProxy(req, target.href, session);
    const type = response.headers.get('content-type') || 'application/octet-stream';
    let body = await responseBodyLimited(response, RENDER_MAX_BYTES);
    const proxyOrigin = proxyOriginFor(req);

    if (/text\/html|application\/xhtml\+xml/i.test(type)) {
      body = Buffer.from(rewriteHtml(body.toString('utf-8'), finalUrl, req.previewKey, proxyOrigin), 'utf-8');
      res.set('Content-Type', 'text/html; charset=utf-8');
      res.set('Cache-Control', 'no-store');
    } else if (/text\/css/i.test(type)) {
      body = Buffer.from(rewriteCss(body.toString('utf-8'), finalUrl, req.previewKey, proxyOrigin), 'utf-8');
      res.set('Content-Type', 'text/css; charset=utf-8');
      res.set('Cache-Control', 'no-store');
    } else {
      res.set('Content-Type', type);
    }

    res.set('X-Content-Type-Options', 'nosniff');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    res.status(response.status).send(body);

    const safeTarget = (() => { try { const u = new URL(finalUrl); return `${u.origin}${u.pathname}`; } catch { return 'invalid'; } })();
    console.log(`[render] user=${session.username} target=${safeTarget} status=${response.status} bytes=${body.length} ms=${Date.now()-started}`);
  } catch (error) {
    const status = Number(error?.statusCode) || (error?.name === 'TimeoutError' ? 504 : 502);
    if (error?.retryAfter) res.set('Retry-After', String(error.retryAfter));
    console.warn(`[render] user=${session.username} status=${status} error=${error?.message || 'unknown'}`);
    res.status(status).json({ error: error?.message || 'Unable to fetch that resource.' });
  } finally {
    if (requestEntered) leaveRenderRequest(session);
  }
});

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public/index.html')));
app.get('/chat.html', (req, res) => res.sendFile(path.join(__dirname, 'public/chat.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

const cleanText = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const normalizeUsername = value => cleanText(value, MAX_USERNAME_LENGTH);
const validUsername = username => /^[A-Za-z0-9_-]{3,24}$/.test(username);
const validColor = color => typeof color === 'string' && /^#[0-9a-fA-F]{6}$/.test(color);
function validAvatar(url) {
  if (!url) return true;
  try { return ['http:', 'https:'].includes(new URL(url).protocol) && url.length <= MAX_AVATAR_URL_LENGTH; }
  catch { return false; }
}
const isAdmin = username => ADMIN_USERS.has(username);

async function getUser(username) {
  const result = await db.query('SELECT username, password_hash, status, muted_until, avatar, color FROM users WHERE username=$1 LIMIT 1', [username]);
  return result.rows[0] || null;
}
async function userExists(username) {
  const result = await db.query('SELECT 1 FROM users WHERE username=$1 LIMIT 1', [username]);
  return result.rowCount > 0;
}
async function userIsBanned(username) {
  const result = await db.query('SELECT 1 FROM banned_users WHERE username=$1 LIMIT 1', [username]);
  return result.rowCount > 0;
}
async function countUsers() {
  const result = await db.query('SELECT COUNT(*)::int AS count FROM users');
  return result.rows[0].count;
}
async function requireAuth(socket) {
  try {
    const token = socket.handshake.auth?.token;
    const username = token ? sessions.get(token) : null;
    if (!username || !(await userExists(username)) || (await userIsBanned(username))) {
      socket.emit('authRequired');
      return null;
    }
    return username;
  } catch {
    socket.emit('errorMessage', 'Authentication service is temporarily unavailable.');
    return null;
  }
}
function addAudit(entry) {
  auditLogs.push({ ...entry, time: Date.now() });
  if (auditLogs.length > 500) auditLogs.shift();
}
async function publicUser(username) {
  const user = await getUser(username);
  return { username, status: user?.status || '', mutedUntil: user?.muted_until ? new Date(user.muted_until).getTime() : null, avatar: user?.avatar || '', color: user?.color || '#ffffff', isAdmin: isAdmin(username) };
}
async function updateUsers() {
  const list = [];
  for (const username of [...new Set(onlineUsers.values())]) list.push(await publicUser(username));
  io.emit('updateUsers', list);
}
function disconnectUser(username, event, reason) {
  for (const [socketId, user] of onlineUsers.entries()) {
    if (user !== username) continue;
    io.to(socketId).emit(event, reason);
    io.sockets.sockets.get(socketId)?.disconnect(true);
  }
}
async function initializeDatabase() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      username VARCHAR(24) NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      status VARCHAR(80) NOT NULL DEFAULT '',
      muted_until TIMESTAMPTZ NULL,
      avatar TEXT NOT NULL DEFAULT '',
      color CHAR(7) NOT NULL DEFAULT '#ffffff',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS banned_users (
      username VARCHAR(24) PRIMARY KEY REFERENCES users(username) ON DELETE CASCADE,
      banned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_username_lower_idx ON users (LOWER(username));
  `);
}

io.on('connection', socket => {
  socket.on('register', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';
    if (!validUsername(username)) return socket.emit('registerError', 'Username must be 3–24 characters and use only letters, numbers, _ or -.');
    if (password.length < 6 || password.length > 128) return socket.emit('registerError', 'Password must be between 6 and 128 characters.');
    try {
      if ((await countUsers()) >= MAX_USERS) return socket.emit('registerError', 'The server is full.');
      if (await userExists(username)) return socket.emit('registerError', 'Username already exists.');
      if (await userIsBanned(username)) return socket.emit('registerError', 'That username is unavailable.');
      const passwordHash = await bcrypt.hash(password, 12);
      await db.query('INSERT INTO users (username, password_hash) VALUES ($1,$2)', [username, passwordHash]);
      addAudit({ action: 'register', user: username });
      socket.emit('registerSuccess');
    } catch (error) {
      if (error.code === '23505') return socket.emit('registerError', 'Username already exists.');
      console.error('Registration error:', error);
      socket.emit('registerError', 'Registration failed. Please try again.');
    }
  });

  socket.on('login', async (payload = {}) => {
    const username = normalizeUsername(payload.username);
    const password = typeof payload.password === 'string' ? payload.password : '';
    try {
      if (await userIsBanned(username)) return socket.emit('loginError', 'You are banned from this chat.');
      const user = await getUser(username);
      if (!user) return socket.emit('loginError', 'User not found.');
      if (!await bcrypt.compare(password, user.password_hash)) return socket.emit('loginError', 'Incorrect password.');
      const token = crypto.randomBytes(32).toString('hex');
      sessions.set(token, username);
      socket.handshake.auth.token = token;
      onlineUsers.set(socket.id, username);
      socket.emit('loginSuccess', { token, username, isAdmin: isAdmin(username) });
      socket.emit('messages', messages);
      await updateUsers();
      addAudit({ action: 'login', user: username });
    } catch (error) {
      console.error('Login error:', error);
      socket.emit('loginError', 'Login failed. Please try again.');
    }
  });

  socket.on('authenticate', async () => {
    const username = await requireAuth(socket);
    if (!username) return;
    onlineUsers.set(socket.id, username);
    socket.emit('authenticated', { username, isAdmin: isAdmin(username) });
    socket.emit('messages', messages);
    await updateUsers();
  });

  socket.on('chat', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    try {
      const user = await getUser(username);
      const message = cleanText(payload, MAX_MESSAGE_LENGTH);
      const now = Date.now();
      if (!user || !message) return;
      const mutedUntil = user.muted_until ? new Date(user.muted_until).getTime() : null;
      if (mutedUntil && now < mutedUntil) return socket.emit('errorMessage', 'You are currently muted.');
      if (socket.data.lastMessageAt && now - socket.data.lastMessageAt < MESSAGE_COOLDOWN_MS) return;
      socket.data.lastMessageAt = now;
      const messageObj = { id: crypto.randomUUID(), user: username, message, time: now, edited: false, color: user.color || '#ffffff', avatar: user.avatar || '' };
      messages.push(messageObj);
      if (messages.length > 1000) messages.shift();
      io.emit('chat', messageObj);
    } catch { socket.emit('errorMessage', 'Unable to send message right now.'); }
  });

  socket.on('whisper', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username) return;
    try {
      const target = normalizeUsername(payload.target);
      const message = cleanText(payload.message, MAX_MESSAGE_LENGTH);
      if (!target || !message || !(await userExists(target)) || await userIsBanned(target)) return socket.emit('errorMessage', 'User not found or message is empty.');
      const whisper = { id: crypto.randomUUID(), from: username, to: target, message, time: Date.now() };
      whispers.push(whisper);
      if (whispers.length > 1000) whispers.shift();
      for (const [socketId, user] of onlineUsers.entries()) if (user === target || user === username) io.to(socketId).emit('whisper', whisper);
    } catch { socket.emit('errorMessage', 'Unable to send whisper right now.'); }
  });

  socket.on('editMessage', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const newText = cleanText(payload.newText, MAX_MESSAGE_LENGTH);
    const msg = messages.find(m => m.id === id);
    if (!msg || !newText || (msg.user !== username && !isAdmin(username))) return;
    msg.message = newText;
    msg.edited = true;
    io.emit('editMessage', msg);
  });

  socket.on('deleteMessage', async payload => {
    const username = await requireAuth(socket);
    if (!username) return;
    const id = typeof payload.id === 'string' ? payload.id : '';
    const msg = messages.find(m => m.id === id);
    if (!msg || (msg.user !== username && !isAdmin(username))) return;
    messages = messages.filter(m => m.id !== id);
    io.emit('deleteMessage', { id });
  });

  socket.on('setStatus', async status => {
    const username = await requireAuth(socket);
    if (!username) return;
    await db.query('UPDATE users SET status=$1 WHERE username=$2', [cleanText(status, MAX_STATUS_LENGTH), username]);
    await updateUsers();
  });
  socket.on('typing', async isTyping => { const username = await requireAuth(socket); if (username) socket.broadcast.emit('typing', { user: username, isTyping: Boolean(isTyping) }); });
  socket.on('setAvatar', async url => {
    const username = await requireAuth(socket);
    if (!username) return;
    const avatar = cleanText(url, MAX_AVATAR_URL_LENGTH);
    if (!validAvatar(avatar)) return socket.emit('errorMessage', 'Avatar must be a valid HTTP(S) URL.');
    await db.query('UPDATE users SET avatar=$1 WHERE username=$2', [avatar, username]);
    await updateUsers();
  });
  socket.on('setColor', async color => {
    const username = await requireAuth(socket);
    if (!username) return;
    if (!validColor(color)) return socket.emit('errorMessage', 'Invalid chat color.');
    await db.query('UPDATE users SET color=$1 WHERE username=$2', [color, username]);
    await updateUsers();
  });
  socket.on('reportAvatar', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username) return;
    const target = normalizeUsername(payload.target);
    if (!target || !(await userExists(target)) || target === username) return;
    avatarReports.push({ reporter: username, target, time: Date.now() });
    if (avatarReports.length > 500) avatarReports.shift();
    addAudit({ action: 'avatar_report', user: username, target });
    if (isAdmin(username)) io.emit('updateReports', avatarReports);
  });

  socket.on('requestAdminData', async () => {
    const username = await requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');
    socket.emit('adminData', { reports: avatarReports, auditLogs });
  });

  socket.on('adminCommand', async (payload = {}) => {
    const username = await requireAuth(socket);
    if (!username || !isAdmin(username)) return socket.emit('adminError', 'Admin access required.');
    const cmd = cleanText(payload.cmd, 20).toLowerCase();
    const target = normalizeUsername(payload.target);
    const arg = cleanText(payload.arg, 200);
    if (target && isAdmin(target) && ['kick', 'ban', 'mute'].includes(cmd)) return socket.emit('adminError', 'You cannot moderate another admin.');
    try {
      if (cmd === 'kick') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        disconnectUser(target, 'kicked', arg || 'Kicked by admin');
        addAudit({ action: 'kick', admin: username, target, reason: arg });
      } else if (cmd === 'ban') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        await db.query('INSERT INTO banned_users (username) VALUES ($1) ON CONFLICT (username) DO NOTHING', [target]);
        disconnectUser(target, 'banned', arg || 'Banned by admin');
        addAudit({ action: 'ban', admin: username, target, reason: arg });
      } else if (cmd === 'mute') {
        if (!(await userExists(target))) return socket.emit('adminError', 'User not found.');
        const seconds = Math.min(Math.max(Number.parseInt(arg, 10) || 60, 1), 86400);
        const mutedUntil = new Date(Date.now() + seconds * 1000);
        await db.query('UPDATE users SET muted_until=$1 WHERE username=$2', [mutedUntil, target]);
        for (const [socketId, user] of onlineUsers.entries()) if (user === target) io.to(socketId).emit('mutedStatus', { mutedUntil: mutedUntil.getTime() });
        addAudit({ action: 'mute', admin: username, target, until: mutedUntil.getTime() });
      } else if (cmd === 'clear') {
        messages = [];
        io.emit('messages', messages);
        addAudit({ action: 'clear', admin: username });
      } else if (cmd === 'unban') {
        await db.query('DELETE FROM banned_users WHERE username=$1', [target]);
        addAudit({ action: 'unban', admin: username, target });
      } else return socket.emit('adminError', 'Unknown command.');
      socket.emit('adminData', { reports: avatarReports, auditLogs });
      await updateUsers();
    } catch (error) {
      console.error('Admin command error:', error);
      socket.emit('adminError', 'Admin command failed.');
    }
  });

  socket.on('disconnect', () => { onlineUsers.delete(socket.id); updateUsers().catch(() => {}); });
});

async function start() {
  try {
    await db.query('SELECT 1');
    await initializeDatabase();
    server.listen(PORT, () => console.log(`Server running on port ${PORT}`));
  } catch (error) {
    console.error('Database startup failed:', error.message);
    await db.end().catch(() => {});
    process.exit(1);
  }
}
process.on('SIGTERM', async () => { await db.end().catch(() => {}); server.close(() => process.exit(0)); });
process.on('SIGINT', async () => { await db.end().catch(() => {}); server.close(() => process.exit(0)); });
start();

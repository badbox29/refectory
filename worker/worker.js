/**
 * Refectory — Cloudflare Worker
 *
 * Environment variables (Cloudflare dashboard):
 *   GOOGLE_CLIENT_ID   — Google OAuth Client ID
 *   ALLOWED_ORIGINS    — Comma-separated allowed origins
 *
 * KV Namespace binding:
 *   REFECTORY_KV       — KV namespace for user data
 *
 * Routes:
 *   GET    /                    — Health check (open CORS)
 *   GET    /ping                — Health check (open CORS)
 *   GET    /auth/config         — Return Google Client ID for GIS bootstrap
 *   POST   /share               — Create a read-only, self-expiring meal plan link
 *   GET    /share/{id}          — Public meal plan page (no auth, no Origin check)
 *   GET    /scrape              — Proxy-fetch a URL and return HTML for recipe scraping
 *   POST   /auth/google         — Verify Google ID token
 *   POST   /auth/verify         — Re-verify stored Google credential at boot
 *   POST   /auth/migrate        — Token → Google migration (HMAC-authenticated)
 *   GET    /storage/:token/:key — Read KV value
 *   PUT    /storage/:token/:key — Write KV value (HMAC signed)
 *   DELETE /storage/:token/:key — Delete KV value
 *   GET    /storage/:token      — List all keys for token
 */

const KV_BINDING          = 'REFECTORY_KV';
const KV_TTL              = 60 * 60 * 24 * 1825; // 5 years, resets on every write
const HMAC_SALT           = 'refectory-hmac-v1'; // must never change after deployment
const MAX_BODY_SIZE       = 5 * 1024 * 1024;      // 5 MB — recipe collections can be large
const AUTH_RATE_LIMIT     = 60;    // interactive sign-in attempts, per IP per window
const VERIFY_RATE_LIMIT   = 200;   // boot-time session checks — unattended, cheap, own budget
const AUTH_RATE_LIMIT_WIN = 3600;
const RATE_LIMIT          = 120;
const RATE_LIMIT_WINDOW   = 60;
const SCRAPE_RATE_LIMIT   = 60;   // scrapes per window, per IP
const SCRAPE_RATE_WINDOW  = 60;   // seconds

// ── Response helpers ───────────────────────────────────────────────────────

function respond(body, status = 200, extra = {}) {
  return new Response(body, { status, headers: { 'Content-Type': 'application/json', ...extra } });
}

// ── CORS ───────────────────────────────────────────────────────────────────

function buildCors(origin) {
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Timestamp, X-Signature',
    // Without this the browser hides these from JS entirely — only CORS-safelisted
    // response headers are readable by default.
    'Access-Control-Expose-Headers': 'Retry-After, X-RateLimit-Remaining, X-Account-Migrated, X-Token-Migrated',
    'Vary': 'Origin',
    'Cache-Control': 'no-store',
  };
}

function getAllowedOrigin(request, allowedOrigins) {
  const origin = request.headers.get('Origin') || '';
  return allowedOrigins.includes(origin) ? origin : null;
}

// ── Token validation ───────────────────────────────────────────────────────

function isValidToken(token) {
  return /^(google:\d{10,30}|[a-zA-Z0-9_-]{8,128})$/.test(token);
}

// ── IP rate limiting (auth routes) ─────────────────────────────────────────

// Fixed-slot window: the key carries the time bucket, so a counter genuinely
// expires after AUTH_RATE_LIMIT_WIN instead of drifting on a doubled TTL.
// Returns { ok, retryAfter?, remaining? }.
async function checkIpRateLimit(env, ip, opts = {}) {
  const limit  = opts.limit  || AUTH_RATE_LIMIT;
  const win    = opts.window || AUTH_RATE_LIMIT_WIN;
  const bucket = opts.bucket || 'auth';
  const now    = Math.floor(Date.now() / 1000);
  const slot   = Math.floor(now / win);
  const kv     = env[KV_BINDING];
  const key    = `rl:ip:${bucket}:${ip}:${slot}`;
  const raw    = await kv.get(key, { type: 'text' });
  const count  = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) {
    return { ok: false, retryAfter: Math.max(1, (slot + 1) * win - now) };
  }
  await kv.put(key, String(count + 1), { expirationTtl: Math.max(60, win + 60) });
  return { ok: true, remaining: limit - count - 1 };
}

// ── HMAC signing (mirrors auth.js exactly) ─────────────────────────────────

async function deriveHmacKey(token) {
  const enc    = new TextEncoder();
  const keyMat = await crypto.subtle.importKey('raw', enc.encode(token), { name: 'HKDF' }, false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: enc.encode(HMAC_SALT), info: enc.encode('request-signing') },
    keyMat,
    { name: 'HMAC', hash: 'SHA-256' },
    false, ['sign', 'verify']
  );
}

async function verifyHmac(request, token, body) {
  const timestamp = request.headers.get('X-Timestamp') || '';
  const signature = request.headers.get('X-Signature') || '';
  if (!timestamp || !signature) return { ok: false, reason: 'Missing HMAC headers' };
  if (Math.abs(Date.now() - parseInt(timestamp, 10)) > 5 * 60 * 1000)
    return { ok: false, reason: 'Timestamp expired' };

  const enc      = new TextEncoder();
  const bodyHash = Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(body || '')))
  ).map(b => b.toString(16).padStart(2, '0')).join('');

  const message  = `${request.method.toUpperCase()}:${token}:${timestamp}:${bodyHash}`;
  try {
    const key      = await deriveHmacKey(token);
    const sigBytes = Uint8Array.from(atob(signature.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid    = await crypto.subtle.verify('HMAC', key, sigBytes, enc.encode(message));
    return valid ? { ok: true } : { ok: false, reason: 'Invalid signature' };
  } catch { return { ok: false, reason: 'Verification error' }; }
}

async function checkAuth(request, token, cors, requireHmac, body, env) {
  if (token.startsWith('google:')) {
    const authHeader = request.headers.get('Authorization') || '';
    const idToken    = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
    if (!idToken) return { ok: false, res: respond(JSON.stringify({ error: 'Authorization required' }), 401, cors) };
    const payload = await verifyGoogleJWT(idToken, env?.GOOGLE_CLIENT_ID);
    if (!payload) return { ok: false, res: respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors) };
    if (token !== `google:${payload.sub}`) return { ok: false, res: respond(JSON.stringify({ error: 'Token mismatch' }), 403, cors) };
    return { ok: true };
  }
  const hmac = await verifyHmac(request, token, body);
  if (!hmac.ok && requireHmac)
    return { ok: false, res: respond(JSON.stringify({ error: `Auth failed: ${hmac.reason}` }), 401, cors) };
  return { ok: true };
}

// ── Google JWT (RS256) ─────────────────────────────────────────────────────

async function verifyGoogleJWT(idToken, clientId) {
  if (!clientId) return null;
  try {
    const parts   = idToken.split('.');
    if (parts.length !== 3) return null;
    const header  = JSON.parse(atob(parts[0].replace(/-/g, '+').replace(/_/g, '/')));
    const payload = JSON.parse(atob(parts[1].replace(/-/g, '+').replace(/_/g, '/')));
    const now     = Math.floor(Date.now() / 1000);
    if (payload.exp < now)   return null;
    if (payload.aud !== clientId) return null;
    if (!['accounts.google.com', 'https://accounts.google.com'].includes(payload.iss)) return null;
    if (!payload.sub) return null;

    const jwksRes = await fetch('https://www.googleapis.com/oauth2/v3/certs');
    if (!jwksRes.ok) return null;
    const jwks    = await jwksRes.json();
    const jwk     = jwks.keys?.find(k => k.kid === header.kid);
    if (!jwk) return null;

    const cryptoKey    = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const signingInput = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const sig          = Uint8Array.from(atob(parts[2].replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
    const valid        = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', cryptoKey, sig, signingInput);
    if (!valid) return null;

    return { sub: payload.sub, email: payload.email || null, name: payload.name || null, picture: payload.picture || null };
  } catch (e) {
    console.error('[Auth] verifyGoogleJWT:', e);
    return null;
  }
}

// ── Auth routes ────────────────────────────────────────────────────────────

async function handleAuth(url, method, request, env, cors, ip) {
  const kv = env[KV_BINDING];

  // GET /auth/config — return Google Client ID so the frontend never stores it
  if (url.pathname === '/auth/config' && method === 'GET') {
    return respond(JSON.stringify({
      googleClientId: env.GOOGLE_CLIENT_ID || '',
    }), 200, cors);
  }

  // POST /auth/verify — boot-time session check. Fires unattended on nearly
  // every boot (Google ID tokens live ~1h), so it gets its own generous budget
  // rather than eating the interactive sign-in allowance.
  if (url.pathname === '/auth/verify' && method === 'POST') {
    const vrl = await checkIpRateLimit(env, ip, { bucket: 'verify', limit: VERIFY_RATE_LIMIT });
    if (!vrl.ok) {
      return respond(JSON.stringify({ ok: false, error: 'Too many requests — try again later' }),
        429, { ...cors, 'Retry-After': String(vrl.retryAfter) });
    }
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors); }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ ok: false, error: 'Token expired or invalid' }), 401, cors);
    return respond(JSON.stringify({ ok: true, profile: p }), 200, cors);
  }

  // Remaining /auth/* routes are IP rate-limited
  const rl = await checkIpRateLimit(env, ip);
  if (!rl.ok) {
    return respond(JSON.stringify({ error: 'Too many requests — try again later' }),
      429, { ...cors, 'Retry-After': String(rl.retryAfter) });
  }

  // POST /auth/google
  if (url.pathname === '/auth/google' && method === 'POST') {
    let idToken;
    try { idToken = (await request.json()).idToken; } catch { return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors); }
    if (!idToken) return respond(JSON.stringify({ error: 'idToken required' }), 400, cors);
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);
    return respond(JSON.stringify({ ok: true, kvKey: `google:${p.sub}`, profile: p }), 200, cors);
  }

  // POST /auth/migrate — FIX: requires HMAC proof of old token ownership
  if (url.pathname === '/auth/migrate' && method === 'POST') {
    const bodyText = await readBodyText(request);
    if (!bodyText) return respond(JSON.stringify({ error: 'Invalid body' }), 400, cors);
    let body;
    try { body = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }

    const { idToken, oldToken } = body || {};
    if (!idToken || !oldToken) return respond(JSON.stringify({ error: 'idToken and oldToken required' }), 400, cors);
    if (!isValidToken(oldToken)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

    // Verify Google credential
    const p = await verifyGoogleJWT(idToken, env.GOOGLE_CLIENT_ID);
    if (!p) return respond(JSON.stringify({ error: 'Invalid or expired Google token' }), 401, cors);

    // FIX: Verify caller controls oldToken via HMAC — closes the gap where any
    // authenticated Google user could migrate a stranger's data.
    const hmac = await verifyHmac(request, oldToken, bodyText);
    if (!hmac.ok) return respond(JSON.stringify({ error: 'Cannot verify ownership of source token' }), 401, cors);

    const kvKey = `google:${p.sub}`;

    // One Google identity = one account
    const existingGoogle = await kv.get(`user:${kvKey}:profile`, { type: 'text' });
    if (existingGoogle) return respond(JSON.stringify({ error: 'A Refectory account already exists for this Google account. Sign in with Google instead.' }), 409, cors);

    const existingRaw = await kv.get(`user:${oldToken}:profile`, { type: 'text' });
    if (!existingRaw) return respond(JSON.stringify({ error: 'Source account not found' }), 404, cors);

    let existing;
    try { existing = JSON.parse(existingRaw); } catch { return respond(JSON.stringify({ error: 'Corrupt source data' }), 500, cors); }

    existing.authMethod   = 'google';
    existing.linkedGoogle = p;
    existing.lastModified = Date.now();

    await kv.put(`user:${kvKey}:profile`, JSON.stringify(existing), { expirationTtl: KV_TTL });
    await kv.put(`migrated:${oldToken}`, kvKey, { expirationTtl: 60 * 60 * 24 * 90 });

    // Copy recipe/ and mealplan/ keys
    const oldPfx = `user:${oldToken}:`;
    const newPfx = `user:${kvKey}:`;
    let cursor;
    do {
      const listed = await kv.list({ prefix: oldPfx, cursor });
      for (const k of listed.keys) {
        const sub = k.name.slice(oldPfx.length);
        if (sub.startsWith('recipe/') || sub.startsWith('mealplan/')) {
          const val = await kv.get(k.name, { type: 'text' });
          if (val !== null) await kv.put(newPfx + sub, val, { expirationTtl: KV_TTL });
        }
      }
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);

    return respond(JSON.stringify({ ok: true, kvKey, profile: p }), 200, cors);
  }

  return null; // no match
}

// ── Storage handler ────────────────────────────────────────────────────────

async function handleStorage(request, env, pathname, cors) {
  if (!env[KV_BINDING]) return respond(JSON.stringify({ error: 'KV not configured' }), 500, cors);

  const parts = pathname.split('/').filter(Boolean);
  if (parts.length < 2) return respond(JSON.stringify({ error: 'Token required' }), 400, cors);

  const token = decodeURIComponent(parts[1]);
  if (!isValidToken(token)) return respond(JSON.stringify({ error: 'Invalid token format' }), 400, cors);

  const rlErr = await checkStorageRateLimit(token, env, cors);
  if (rlErr) return rlErr;

  // GET /storage/:token — list keys
  if (parts.length === 2 && request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    return await listKeys(token, env, cors);
  }

  if (parts.length < 3) return respond(JSON.stringify({ error: 'Key required' }), 400, cors);

  const userKey = parts.slice(2).join('/');
  if (!/^[a-zA-Z0-9_\-./]{1,256}$/.test(userKey))
    return respond(JSON.stringify({ error: 'Invalid key format' }), 400, cors);

  const kvKey = `user:${token}:${userKey}`;

  if (request.method === 'GET') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;

    const { remaining } = await rateLimitCount(token, env);
    const tombRes = await checkMigrationTombstone(token, env, cors, remaining);
    if (tombRes) return tombRes;
    const fwdRes = await checkLegacyForward(token, env, cors, remaining);
    if (fwdRes) return fwdRes;

    const value = await env[KV_BINDING].get(kvKey, { type: 'text' });
    if (value === null) return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    return respond(JSON.stringify({ value: JSON.parse(value) }), 200, cors);
  }

  if (request.method === 'PUT') {
    const bodyText = await readBodyText(request);
    if (bodyText === null) return respond(JSON.stringify({ error: 'Invalid or oversized body' }), 400, cors);
    let parsed;
    try { parsed = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }

    const auth = await checkAuth(request, token, cors, true, bodyText, env);
    if (!auth.ok) return auth.res;

    parsed = await writeLegacyPointer(parsed, token, env);
    await env[KV_BINDING].put(kvKey, JSON.stringify(parsed), { expirationTtl: KV_TTL });
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  if (request.method === 'DELETE') {
    const auth = await checkAuth(request, token, cors, true, null, env);
    if (!auth.ok) return auth.res;
    await env[KV_BINDING].delete(kvKey);
    return respond(JSON.stringify({ ok: true }), 200, cors);
  }

  return respond(JSON.stringify({ error: 'Method not allowed' }), 405, cors);
}

async function listKeys(token, env, cors) {
  const prefix = `user:${token}:`;
  const list   = await env[KV_BINDING].list({ prefix });
  return respond(JSON.stringify({
    keys: list.keys.map(k => ({ key: k.name.slice(prefix.length), expiration: k.expiration })),
    list_complete: list.list_complete,
  }), 200, cors);
}

// ── Migration helpers ──────────────────────────────────────────────────────

async function checkMigrationTombstone(token, env, cors, remaining) {
  const migratedTo = await env[KV_BINDING].get(`migrated:${token}`, { type: 'text' });
  if (!migratedTo) return null;
  return respond(
    JSON.stringify({ migrated: true, authMethod: 'google' }),
    410,
    { ...cors, 'X-Account-Migrated': 'google', 'X-RateLimit-Remaining': String(remaining) }
  );
}

async function checkLegacyForward(token, env, cors, remaining) {
  const forwardTo = await env[KV_BINDING].get(`legacy:${token}`, { type: 'text' });
  if (!forwardTo) return null;
  const newData = await env[KV_BINDING].get(forwardTo, { type: 'text' });
  if (!newData) return null;
  return respond(newData, 200, { ...cors, 'X-Token-Migrated': forwardTo, 'X-RateLimit-Remaining': String(remaining) });
}

async function writeLegacyPointer(parsed, newToken, env) {
  const legacy = parsed._legacyToken;
  if (legacy && typeof legacy === 'string' && isValidToken(legacy) && legacy !== newToken) {
    delete parsed._legacyToken;
    await env[KV_BINDING].put(`legacy:${legacy}`, newToken, { expirationTtl: 60 * 60 * 24 * 90 });
  } else {
    delete parsed._legacyToken;
  }
  return parsed;
}

// ── Meal plan sharing ──────────────────────────────────────────────────────
// A share is a read-only, self-expiring window onto one date range of one
// account. The record holds the owner's token so the page can read live data
// — change the plan and the link reflects it — but the rendered page exposes
// only dish name, image and description. No ingredients: telling a kid that
// the thing they've happily eaten for years contains soy sauce is a good way
// to stop them eating it.
const SHARE_MAX_DAYS = 62;

function shareId() {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ISO week key for a calendar date, matching the client's getISOWeekKey.
// Built entirely from UTC components so the Worker — which runs in UTC —
// derives the same week for a given Y-M-D as the browser does locally.
function isoWeekKeyUTC(y, m, d) {
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + 3 - ((dt.getUTCDay() + 6) % 7));
  const week1 = new Date(Date.UTC(dt.getUTCFullYear(), 0, 4));
  const wn = 1 + Math.round(((dt - week1) / 86400000 - 3 + ((week1.getUTCDay() + 6) % 7)) / 7);
  return `${dt.getUTCFullYear()}-W${String(wn).padStart(2, '0')}`;
}

function dayIndexUTC(y, m, d) {
  return (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7;   // Mon = 0
}

const SHARE_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'];
const LEFTOVERS_PFX = 'leftovers:';

function shareSlotEntries(v) {
  if (v == null) return [];
  return (Array.isArray(v) ? v : [v]).filter(Boolean);
}

function shortDesc(text, max = 180) {
  const t = String(text || '').replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sp  = cut.lastIndexOf(' ');
  return (sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[,;:.\s]+$/, '') + '…';
}

// Walk the shared date range and pull out what the page needs.
function buildShareDays(profile, fromStr, toStr) {
  const recipes = profile?.recipes || {};
  const plan    = profile?.mealplan || {};
  const [fy, fm, fd] = fromStr.split('-').map(Number);
  const [ty, tm, td] = toStr.split('-').map(Number);
  const start = Date.UTC(fy, fm - 1, fd);
  const end   = Date.UTC(ty, tm - 1, td);
  const days  = [];

  for (let ts = start; ts <= end; ts += 86400000) {
    const dt = new Date(ts);
    const y = dt.getUTCFullYear(), m = dt.getUTCMonth() + 1, d = dt.getUTCDate();
    const dayPlan = plan?.[isoWeekKeyUTC(y, m, d)]?.[dayIndexUTC(y, m, d)] || {};

    const meals = [];
    for (const slot of SHARE_SLOTS) {
      for (const entry of shareSlotEntries(dayPlan[slot])) {
        if (entry === 'fend') { meals.push({ slot, fend: true }); continue; }
        const leftover = typeof entry === 'string' && entry.startsWith(LEFTOVERS_PFX);
        const id = leftover ? entry.slice(LEFTOVERS_PFX.length) : entry;
        const r  = recipes[id];
        if (!r) continue;
        meals.push({
          slot,
          leftover,
          title: r.title || 'Untitled',
          // Only remote links can render here — IndexedDB bytes are on her
          // device and unreachable from the Worker.
          image: /^https?:\/\//i.test(r.imageUrl || '') ? r.imageUrl : '',
          desc:  shortDesc(r.description),
        });
      }
    }
    if (meals.length) {
      days.push({
        label: dt.toLocaleDateString('en-US',
          { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }),
        meals,
      });
    }
  }
  return days;
}

function sharePage({ title, subtitle, days, expired }) {
  const body = expired
    ? `<div class="gone"><h1>This link has expired</h1>
         <p>Meal plan links stop working at the end of the range they cover.
            Ask for a fresh one.</p></div>`
    : !days.length
      ? `<div class="gone"><h1>${escHtml(title)}</h1><p>Nothing planned for these days yet.</p></div>`
      : `<header><h1>${escHtml(title)}</h1><p class="sub">${escHtml(subtitle)}</p></header>
         ${days.map(day => `
           <section class="day">
             <h2>${escHtml(day.label)}</h2>
             ${day.meals.map(mm => mm.fend
               ? `<article class="meal fend">
                    <div class="txt"><span class="slot">${escHtml(mm.slot)}</span>
                    <h3>Fend for yourselves</h3></div>
                  </article>`
               : `<article class="meal">
                    ${mm.image
                      ? `<img src="${escHtml(mm.image)}" alt="" loading="lazy" referrerpolicy="no-referrer"/>`
                      : `<div class="noimg" aria-hidden="true">🍽</div>`}
                    <div class="txt">
                      <span class="slot">${escHtml(mm.slot)}${mm.leftover ? ' · leftovers' : ''}</span>
                      <h3>${escHtml(mm.title)}</h3>
                      ${mm.desc ? `<p>${escHtml(mm.desc)}</p>` : ''}
                    </div>
                  </article>`).join('')}
           </section>`).join('')}`;

  return `<!doctype html><html lang="en"><head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<meta name="robots" content="noindex,nofollow"/>
<title>${escHtml(expired ? 'Link expired' : title)}</title>
<style>
  :root { --ink:#2b2a26; --muted:#6f6b61; --cream:#faf7f0; --card:#fff;
          --line:#e6e0d4; --green:#6b8c5a; }
  * { box-sizing:border-box; margin:0; padding:0; }
  body { background:var(--cream); color:var(--ink); font:16px/1.5 -apple-system,
         BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; padding:1rem;
         max-width:640px; margin:0 auto; }
  header { padding:.5rem 0 1rem; }
  h1 { font-size:1.5rem; line-height:1.2; }
  .sub { color:var(--muted); font-size:.9rem; margin-top:.2rem; }
  .day { margin-bottom:1.5rem; }
  .day h2 { font-size:.8rem; text-transform:uppercase; letter-spacing:.06em;
            color:var(--green); font-weight:700; margin-bottom:.5rem;
            padding-bottom:.3rem; border-bottom:1px solid var(--line); }
  .meal { display:flex; gap:.75rem; background:var(--card);
          border:1px solid var(--line); border-radius:10px;
          padding:.6rem; margin-bottom:.5rem; }
  .meal img, .noimg { width:76px; height:76px; flex:0 0 76px;
          border-radius:7px; object-fit:cover; background:#efe9dd; }
  .noimg { display:flex; align-items:center; justify-content:center;
           font-size:1.6rem; opacity:.45; }
  .txt { min-width:0; align-self:center; }
  .slot { font-size:.68rem; text-transform:uppercase; letter-spacing:.05em;
          color:var(--muted); font-weight:600; }
  .meal h3 { font-size:1rem; line-height:1.25; margin:.1rem 0 .2rem; }
  .meal p { font-size:.85rem; color:var(--muted); }
  .fend .txt { align-self:center; }
  .gone { text-align:center; padding:3rem 1rem; }
  .gone h1 { margin-bottom:.5rem; }
  .gone p { color:var(--muted); }
  footer { text-align:center; color:var(--muted); font-size:.75rem;
           padding:1.5rem 0 .5rem; }
  @media (prefers-color-scheme: dark) {
    :root { --ink:#ece7dc; --muted:#a49e91; --cream:#22211d;
            --card:#2c2b26; --line:#3b3931; --green:#93b47a; }
  }
</style></head><body>${body}
<footer>Shared from Refectory${expired ? '' : ' · this link expires automatically'}</footer>
</body></html>`;
}

async function handleSharePage(id, env) {
  const html = (b, status) => new Response(b, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8',
               'Cache-Control': 'no-store',
               'X-Robots-Tag': 'noindex, nofollow' },
  });

  if (!/^[a-f0-9]{24,64}$/.test(id || '')) return html(sharePage({ expired: true }), 404);

  const raw = await env[KV_BINDING].get(`share:${id}`, { type: 'text' });
  if (!raw) return html(sharePage({ expired: true }), 404);

  let rec;
  try { rec = JSON.parse(raw); } catch { return html(sharePage({ expired: true }), 404); }

  // KV expiry is eventually consistent, so a link could outlive its TTL by a
  // while. Check the stored timestamp too.
  if (!rec.expiresAt || Date.now() > rec.expiresAt) {
    return html(sharePage({ expired: true }), 410);
  }

  const profileRaw = await env[KV_BINDING].get(`user:${rec.token}:profile`, { type: 'text' });
  if (!profileRaw) return html(sharePage({ expired: true }), 404);

  let profile;
  try { profile = JSON.parse(profileRaw); } catch { return html(sharePage({ expired: true }), 500); }

  const days = buildShareDays(profile, rec.from, rec.to);
  return html(sharePage({
    title: rec.title || 'Meal Plan',
    subtitle: rec.subtitle || `${rec.from} – ${rec.to}`,
    days,
  }), 200);
}

async function handleCreateShare(request, env, cors) {
  const bodyText = await readBodyText(request);
  if (bodyText === null) return respond(JSON.stringify({ error: 'Invalid or oversized body' }), 400, cors);
  let b;
  try { b = JSON.parse(bodyText); } catch { return respond(JSON.stringify({ error: 'Invalid JSON' }), 400, cors); }

  const token = String(b.token || '');
  if (!token) return respond(JSON.stringify({ error: 'token required' }), 400, cors);

  // Same signing as every other write — only the account owner can publish a
  // window onto their own data.
  const auth = await checkAuth(request, token, cors, true, bodyText, env);
  if (!auth.ok) return auth.res;

  const dateOk = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''));
  if (!dateOk(b.from) || !dateOk(b.to))
    return respond(JSON.stringify({ error: 'from and to must be YYYY-MM-DD' }), 400, cors);
  if (b.to < b.from)
    return respond(JSON.stringify({ error: 'to is before from' }), 400, cors);

  const spanDays = Math.round(
    (Date.parse(b.to + 'T00:00:00Z') - Date.parse(b.from + 'T00:00:00Z')) / 86400000) + 1;
  if (spanDays > SHARE_MAX_DAYS)
    return respond(JSON.stringify({ error: `Range longer than ${SHARE_MAX_DAYS} days` }), 400, cors);

  // The client computes expiry as midnight after the final day *in its own
  // timezone* — the Worker has no idea where she is, so it can't derive this.
  const expiresAt = Number(b.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now())
    return respond(JSON.stringify({ error: 'expiresAt must be in the future' }), 400, cors);
  const maxExpiry = Date.now() + (SHARE_MAX_DAYS + 2) * 86400000;
  if (expiresAt > maxExpiry)
    return respond(JSON.stringify({ error: 'expiresAt too far ahead' }), 400, cors);

  const id  = shareId();
  const ttl = Math.max(60, Math.ceil((expiresAt - Date.now()) / 1000));
  await env[KV_BINDING].put(`share:${id}`, JSON.stringify({
    token,
    from: b.from,
    to:   b.to,
    title:    String(b.title || '').slice(0, 120),
    subtitle: String(b.subtitle || '').slice(0, 160),
    expiresAt,
    createdAt: Date.now(),
  }), { expirationTtl: ttl });

  return respond(JSON.stringify({ ok: true, id, expiresAt }), 200, cors);
}

// ── Rate limiting (scrape) ─────────────────────────────────────────────────

// Timestamp-array window, matching the storage limiter. The previous counter
// reset its own TTL on every write, so the expiry slid forward indefinitely
// and the bucket only cleared after a full window of total silence — meaning
// ten scrapes spread across an evening would still trip it.
//
// Returns null when allowed, or { retryAfter } when the caller must wait.
async function scrapeRateLimit(env, ip) {
  const kv    = env[KV_BINDING];
  const key   = `scrape:${ip}`;
  const now   = Math.floor(Date.now() / 1000);
  const win   = now - SCRAPE_RATE_WINDOW;

  let ts = [];
  const stored = await kv.get(key, { type: 'text' });
  if (stored) {
    try {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed)) ts = parsed.filter(t => t > win);
    } catch {
      // Legacy plain-integer counter from the previous scheme — drop it
    }
  }

  if (ts.length >= SCRAPE_RATE_LIMIT) {
    // Oldest entry ages out of the window first; that's when a slot frees up
    const retryAfter = Math.max(1, ts[0] + SCRAPE_RATE_WINDOW - now);
    return { retryAfter };
  }

  ts.push(now);
  // TTL covers the window from *this* write; entries older than the window are
  // filtered on read anyway, so a slightly generous TTL is harmless.
  await kv.put(key, JSON.stringify(ts), { expirationTtl: SCRAPE_RATE_WINDOW * 2 });
  return null;
}

// ── Rate limiting (storage) ────────────────────────────────────────────────

async function checkStorageRateLimit(token, env, cors) {
  const rlKey  = `ratelimit:${token}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  if (ts.length >= RATE_LIMIT)
    return respond(JSON.stringify({ error: 'Rate limit exceeded — please wait' }), 429, cors);
  ts.push(now);
  await env[KV_BINDING].put(rlKey, JSON.stringify(ts), { expirationTtl: RATE_LIMIT_WINDOW * 2 });
  return null;
}

async function rateLimitCount(token, env) {
  const rlKey  = `ratelimit:${token}`;
  const now    = Math.floor(Date.now() / 1000);
  const win    = now - RATE_LIMIT_WINDOW;
  let ts       = [];
  const stored = await env[KV_BINDING].get(rlKey, { type: 'text' });
  if (stored) { try { ts = JSON.parse(stored).filter(t => t > win); } catch {} }
  return { remaining: Math.max(0, RATE_LIMIT - ts.length) };
}

// ── Body helpers ───────────────────────────────────────────────────────────

async function readBodyText(request) {
  const cl = parseInt(request.headers.get('Content-Length') || '0', 10);
  if (cl > MAX_BODY_SIZE) return null;
  try {
    const text = await request.text();
    return text.length > MAX_BODY_SIZE ? null : text;
  } catch { return null; }
}

// ── Entry point ────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method.toUpperCase();
    const ip     = request.headers.get('CF-Connecting-IP') || '0.0.0.0';

    // Health check — open CORS, no auth (needed by Auth.testWorkerUrl)
    if (method === 'GET' && (url.pathname === '/' || url.pathname === '/ping')) {
      return new Response(JSON.stringify({ ok: true, ts: Date.now(), app: 'Refectory' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
      });
    }

    // GET /share/{id} — the public read-only page. Routed before the origin
    // allowlist on purpose: this is opened by tapping a link, and a top-level
    // browser navigation sends no Origin header, so the allowlist would 403
    // every recipient. Safe because the handler takes no input beyond an
    // unguessable id and returns only rendered HTML.
    if (method === 'GET' && url.pathname.startsWith('/share/')) {
      try {
        return await handleSharePage(url.pathname.slice('/share/'.length), env);
      } catch (err) {
        console.error('Share page error:', err);
        return new Response('<!doctype html><p>Something went wrong loading this meal plan.',
          { status: 500, headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
    }

    // Origin allowlist
    const allowedOrigins = (env.ALLOWED_ORIGINS || '').split(',').map(o => o.trim()).filter(Boolean);
    const origin         = getAllowedOrigin(request, allowedOrigins);
    if (!origin) return new Response(JSON.stringify({ error: 'Forbidden' }), { status: 403, headers: { 'Content-Type': 'application/json' } });
    const cors = buildCors(origin);

    if (method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    try {
      if (url.pathname.startsWith('/auth/')) {
        const r = await handleAuth(url, method, request, env, cors, ip);
        if (r) return r;
      }

      // POST /share — create a link. Authenticated like any other write.
      if (url.pathname === '/share' && method === 'POST') {
        return await handleCreateShare(request, env, cors);
      }

      if (url.pathname.startsWith('/storage')) {
        return await handleStorage(request, env, url.pathname.replace(/\/$/, ''), cors);
      }

      // GET /scrape?url=... — server-side fetch to bypass CORS for recipe scraping
      if (url.pathname === '/scrape' && method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) return respond(JSON.stringify({ error: 'url param required' }), 400, cors);
        // Basic URL validation
        let parsed;
        try { parsed = new URL(targetUrl); } catch { return respond(JSON.stringify({ error: 'Invalid URL' }), 400, cors); }
        if (!['http:', 'https:'].includes(parsed.protocol)) return respond(JSON.stringify({ error: 'Only http/https URLs allowed' }), 400, cors);
        // Rate-limit by IP, sliding window
        const rl = await scrapeRateLimit(env, ip);
        if (rl) {
          return respond(
            JSON.stringify({ error: `Rate limit — retry in ${rl.retryAfter}s`, retryAfter: rl.retryAfter }),
            429,
            { ...cors, 'Retry-After': String(rl.retryAfter) }
          );
        }
        try {
          const res = await fetch(targetUrl, {
            headers: {
              'User-Agent': 'Mozilla/5.0 (compatible; Refectory/1.0; recipe scraper)',
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
              'Accept-Language': 'en-US,en;q=0.9',
            },
            redirect: 'follow',
            // cacheEverything is required for HTML to be cached at all; with it
            // off the cacheTtl below was a no-op.
            cf: { cacheTtl: 900, cacheEverything: true },
          });
          if (!res.ok) return respond(JSON.stringify({ error: `Fetch failed: ${res.status}` }), 502, cors);
          const html = await res.text();
          // Return HTML — client does all the parsing
          return new Response(JSON.stringify({ ok: true, html, finalUrl: res.url }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', ...cors },
          });
        } catch(e) {
          return respond(JSON.stringify({ error: `Could not fetch URL: ${e.message}` }), 502, cors);
        }
      }

      return respond(JSON.stringify({ error: 'Not found' }), 404, cors);
    } catch (err) {
      console.error('Worker error:', err);
      return respond(JSON.stringify({ error: 'Internal server error' }), 500, cors);
    }
  },
};

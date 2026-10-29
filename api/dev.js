// Dev-menu storage: lets the site owner rename/delete/add games and change the UI for EVERYONE.
// Stored in Upstash Redis (add the "Upstash Redis" integration in Vercel -> Storage; it sets
// KV_REST_API_URL + KV_REST_API_TOKEN). Writes need DEV_PASSWORD (set it in Vercel env vars).
// GET  /api/dev                      -> public config everyone loads
// POST /api/dev {pw, action:'check'|'save'|'hist'|'restore', ...}
const crypto = require('crypto');

const KEY = 'void:dev', HIST = 'void:dev:hist';
const cfg = () => {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ''), token } : null;
};

async function redis(cmds) {
  const c = cfg();
  const r = await fetch(c.url + '/pipeline', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + c.token, 'content-type': 'application/json' },
    body: JSON.stringify(cmds),
  });
  if (!r.ok) throw new Error('storage ' + r.status);
  const out = await r.json();
  return out.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

const str = (v, max = 2000) => (typeof v === 'string' ? v.slice(0, max) : '');
const safeLink = (v) => { v = str(v); return v && !/^\s*(javascript|data|vbscript|file):/i.test(v) ? v : ''; };
const UI_BOOL = ['hideSpot', 'hideEcl', 'hideCont', 'hideFavs', 'hidePop', 'hideGen', 'hideHelp', 'hideFoot'];

function sanitize(x) {
  x = x && typeof x === 'object' ? x : {};
  const out = { games: {}, extra: [], ui: {} };
  const g = x.games && typeof x.games === 'object' ? x.games : {};
  for (const o of Object.keys(g).slice(0, 1500)) {
    const v = g[o] || {}, c = {};
    for (const k of ['name', 'cat', 'desc']) if (str(v[k], 400)) c[k] = str(v[k], 400);
    for (const k of ['img', 'url']) if (safeLink(v[k])) c[k] = safeLink(v[k]);
    if (v.hidden === true) c.hidden = true;
    if (Array.isArray(v.alias)) c.alias = v.alias.slice(0, 20).map((a) => str(a, 200)).filter(Boolean);
    if (Object.keys(c).length) out.games[str(o, 300)] = c;
  }
  for (const e of (Array.isArray(x.extra) ? x.extra : []).slice(0, 600)) {
    if (!e || !str(e.n, 200) || !safeLink(e.u)) continue;
    out.extra.push({
      x: Number(e.x) || Date.now() + out.extra.length, n: str(e.n, 200), u: safeLink(e.u), img: safeLink(e.img),
      c: str(e.c, 40) || 'Action', t: str(e.t, 400),
      alias: Array.isArray(e.alias) ? e.alias.slice(0, 20).map((a) => str(a, 200)).filter(Boolean) : [],
    });
  }
  const u = x.ui && typeof x.ui === 'object' ? x.ui : {};
  for (const k of ['siteName', 'word2', 'tag', 'foot']) if (str(u[k], 80)) out.ui[k] = str(u[k], 80);
  if (str(u.css, 20000)) out.ui.css = str(u.css, 20000);
  for (const k of UI_BOOL) if (u[k] === true) out.ui[k] = true;
  if (Array.isArray(x.pop)) out.pop = x.pop.slice(0, 100).map((o) => str(o, 300)).filter(Boolean);
  return out;
}

const same = (a, b) => {
  const A = Buffer.from(String(a || '')), B = Buffer.from(String(b || ''));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const summary = (d) => ({
  edited: Object.keys(d.games || {}).filter((o) => Object.keys(d.games[o]).some((k) => k !== 'alias' && k !== 'hidden')).length,
  deleted: Object.keys(d.games || {}).filter((o) => d.games[o].hidden).length,
  added: (d.extra || []).length,
});

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const send = (code, obj, cache) => { res.statusCode = code; res.setHeader('cache-control', cache || 'no-store'); res.end(JSON.stringify(obj)); };
  const c = cfg();

  if (req.method === 'GET') {
    if (!c) return send(200, { server: false });
    try {
      const [v] = await redis([['GET', KEY]]);
      return send(200, { server: true, writable: !!process.env.DEV_PASSWORD, dev: v ? JSON.parse(v) : null },
        'public, max-age=0, s-maxage=10, stale-while-revalidate=60');
    } catch (e) { return send(200, { server: false, error: 'storage' }); }
  }
  if (req.method !== 'POST') return send(405, { error: 'method' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  const pw = process.env.DEV_PASSWORD;
  if (!c || !pw) return send(503, { error: 'not_configured', storage: !!c, password: !!pw });
  // Lockout so even a short password can't be guessed: 8 wrong tries per IP, or 60 in total, locks for 15 minutes.
  const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'x').split(',')[0].trim().slice(0, 64);
  const [fIp, fAll] = await redis([['GET', 'void:fail:' + ip], ['GET', 'void:fail:all']]);
  if (Number(fIp) >= 8 || Number(fAll) >= 60) { await sleep(500); return send(429, { error: 'locked' }); }
  if (!same(b.pw, pw)) {
    await redis([['INCR', 'void:fail:' + ip], ['EXPIRE', 'void:fail:' + ip, 900], ['INCR', 'void:fail:all'], ['EXPIRE', 'void:fail:all', 900]]);
    await sleep(900);
    return send(401, { error: 'bad_password' });
  }

  try {
    if (b.action === 'check') return send(200, { ok: true });
    if (b.action === 'save' || b.action === 'restore') {
      let next;
      const [prev, list] = await redis([['GET', KEY], ['LRANGE', HIST, 0, 19]]);
      if (b.action === 'restore') {
        const item = list[Number(b.i)];
        if (!item) return send(404, { error: 'no_such_version' });
        next = sanitize(JSON.parse(JSON.parse(item).dev));
      } else {
        next = sanitize(b.dev);
      }
      const json = JSON.stringify(next);
      if (json.length > 400000) return send(413, { error: 'too_big' });
      const cmds = [];
      if (prev && prev !== json) {
        cmds.push(['LPUSH', HIST, JSON.stringify({ t: Date.now(), dev: prev })], ['LTRIM', HIST, 0, 19]);
      }
      cmds.push(['SET', KEY, json]);
      await redis(cmds);
      return send(200, { ok: true, dev: next });
    }
    if (b.action === 'hist') {
      const [list] = await redis([['LRANGE', HIST, 0, 19]]);
      return send(200, { ok: true, versions: list.map((s, i) => { const o = JSON.parse(s); return { i, t: o.t, ...summary(JSON.parse(o.dev)) }; }) });
    }
    return send(400, { error: 'action' });
  } catch (e) {
    return send(502, { error: 'storage' });
  }
};
module.exports.sanitize = sanitize;

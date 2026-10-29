// Dev-menu storage: lets the site owner rename/delete/add games and change the UI for EVERYONE.
// Saved in a Vercel Blob store (BLOB_READ_WRITE_TOKEN is set when the store is connected to the project).
// Writes need DEV_PASSWORD (set it in the project's environment variables).
// GET  /api/dev                      -> public config everyone loads
// POST /api/dev {pw, action:'check'|'save'|'hist'|'restore', ...}
const crypto = require('crypto');
const { put, get, list, del } = require('@vercel/blob');

const KEY = 'void/dev.json', HIST = 'void/hist/', FAIL = 'void/fail.json';
const hasStore = () => !!process.env.BLOB_READ_WRITE_TOKEN;

async function readText(pathname) {
  const r = await get(pathname, { access: 'public', useCache: false });
  if (!r || r.statusCode !== 200 || !r.stream) return null;
  return await new Response(r.stream).text();
}
async function readJson(pathname) {
  try { const t = await readText(pathname); return t ? JSON.parse(t) : null; } catch (e) { return null; }
}
const writeText = (pathname, text) => put(pathname, text, {
  access: 'public', addRandomSuffix: false, allowOverwrite: true, contentType: 'application/json', cacheControlMaxAge: 60,
});
async function histList() {
  const { blobs } = await list({ prefix: HIST, limit: 100 });
  return blobs.sort((a, b) => (a.pathname < b.pathname ? 1 : -1));
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

  if (req.method === 'GET') {
    if (!hasStore()) return send(200, { server: false });
    try {
      const dev = await readJson(KEY);
      return send(200, { server: true, writable: !!process.env.DEV_PASSWORD, dev },
        'public, max-age=0, s-maxage=10, stale-while-revalidate=60');
    } catch (e) { return send(200, { server: false, error: 'storage' }); }
  }
  if (req.method !== 'POST') return send(405, { error: 'method' });

  let b = req.body;
  if (typeof b === 'string') { try { b = JSON.parse(b); } catch (e) { b = {}; } }
  b = b && typeof b === 'object' ? b : {};
  const pw = process.env.DEV_PASSWORD;
  if (!hasStore() || !pw) return send(503, { error: 'not_configured', storage: hasStore(), password: !!pw });

  try {
    // Lockout so even a short password can't be guessed: 8 wrong tries per IP, or 60 in total, locks for 15 minutes.
    const ip = String((req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || 'x').split(',')[0].trim().slice(0, 64);
    let fail = await readJson(FAIL);
    if (!fail || Date.now() - fail.t > 900000) fail = { t: Date.now(), all: 0, ips: {} };
    if ((fail.ips[ip] || 0) >= 8 || fail.all >= 60) { await sleep(500); return send(429, { error: 'locked' }); }
    if (!same(b.pw, pw)) {
      fail.all++; fail.ips[ip] = (fail.ips[ip] || 0) + 1;
      await writeText(FAIL, JSON.stringify(fail));
      await sleep(900);
      return send(401, { error: 'bad_password' });
    }

    if (b.action === 'check') return send(200, { ok: true });
    if (b.action === 'save' || b.action === 'restore') {
      let next;
      const prev = await readText(KEY);
      if (b.action === 'restore') {
        const item = (await histList())[Number(b.i)];
        if (!item) return send(404, { error: 'no_such_version' });
        next = sanitize(JSON.parse(await readText(item.pathname)));
      } else {
        next = sanitize(b.dev);
      }
      const json = JSON.stringify(next);
      if (json.length > 400000) return send(413, { error: 'too_big' });
      if (prev && prev !== json) {
        let sm = { edited: 0, deleted: 0, added: 0 };
        try { sm = summary(JSON.parse(prev)); } catch (e) { /* keep zeros */ }
        await writeText(`${HIST}${Date.now()}-${sm.edited}-${sm.deleted}-${sm.added}.json`, prev);
        const all = await histList();
        if (all.length > 20) await del(all.slice(20).map((x) => x.url));
      }
      await writeText(KEY, json);
      return send(200, { ok: true, dev: next });
    }
    if (b.action === 'hist') {
      const all = (await histList()).slice(0, 20);
      return send(200, { ok: true, versions: all.map((x, i) => {
        const m = /\/(\d+)-(\d+)-(\d+)-(\d+)\.json$/.exec(x.pathname) || [];
        return { i, t: Number(m[1]) || 0, edited: Number(m[2]) || 0, deleted: Number(m[3]) || 0, added: Number(m[4]) || 0 };
      }) });
    }
    return send(400, { error: 'action' });
  } catch (e) {
    return send(502, { error: 'storage' });
  }
};
module.exports.sanitize = sanitize;

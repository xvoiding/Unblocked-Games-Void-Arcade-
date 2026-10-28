// Vercel adapter for /go. HTML/CSS get rewritten; everything else streams straight through.
const { checkUrl, looksAdultHtml } = require('../netlify/functions/blocklist');
const { rewriteHtml } = require('../netlify/functions/proxy');
const { Readable } = require('node:stream');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const prox = (abs) => '/go?u=' + encodeURIComponent(abs);

function page(status, title, msg) {
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>html,body{height:100%;margin:0;background:#000;color:#fff;font:15px ui-monospace,Menlo,Consolas,monospace}body{display:flex;align-items:center;justify-content:center;text-align:center}div{max-width:420px;padding:24px;border:1px solid #333}h1{font-size:18px;margin:0 0 10px}p{color:#aaa;margin:0}</style>
<div><h1>${title}</h1><p>${msg}</p></div>`;
}

function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, val) => {
    const v = val.trim();
    if (!v || v.startsWith('#') || /^(javascript|data|mailto|tel|blob|about):/i.test(v)) return m;
    try {
      const abs = new URL(v, base).href;
      return /^https?:/i.test(abs) ? `url(${q}${prox(abs)}${q})` : m;
    } catch { return m; }
  });
}

module.exports = async (req, res) => {
  const target = req.query && req.query.u;
  res.setHeader('access-control-allow-origin', '*');
  if (!target) {
    res.status(400); res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page(400, 'No address', 'Nothing to load.'));
  }

  const check = checkUrl(target);
  if (!check.ok) {
    res.status(403); res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page(403, 'Blocked', check.reason));
  }

  const method = req.method === 'POST' ? 'POST' : req.method === 'HEAD' ? 'HEAD' : 'GET';
  const headers = {
    'user-agent': UA,
    accept: req.headers.accept || '*/*',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    referer: new URL(target).origin + '/'
  };

  let r;
  try {
    r = await fetch(target, { method, headers, redirect: 'follow', signal: AbortSignal.timeout(25000) });
  } catch {
    res.status(504); res.setHeader('content-type', 'text/html; charset=utf-8');
    return res.send(page(504, "Couldn't load that", 'The site took too long or refused the connection.'));
  }

  const ct = r.headers.get('content-type') || 'application/octet-stream';
  const len = r.headers.get('content-length');
  const finalUrl = r.url || target;

  if (method === 'HEAD') {
    res.status(r.status); res.setHeader('content-type', ct); res.setHeader('cache-control', 'no-store');
    if (len) res.setHeader('content-length', len);
    return res.end();
  }

  if (/text\/html|application\/xhtml/i.test(ct)) {
    const html = await r.text();
    res.status(r.status); res.setHeader('content-type', ct); res.setHeader('cache-control', 'no-store');
    if (looksAdultHtml(html)) return res.send(page(403, 'Blocked', 'This page looks like adult content.'));
    return res.send(rewriteHtml(html, finalUrl));
  }

  if (/text\/css/i.test(ct)) {
    const css = await r.text();
    res.status(r.status); res.setHeader('content-type', ct); res.setHeader('cache-control', 'no-store');
    return res.send(rewriteCss(css, finalUrl));
  }

  // binary — stream it, no buffering, no base64, no size ceiling of our own
  res.status(r.status);
  res.setHeader('content-type', ct);
  res.setHeader('cache-control', 'public, max-age=3600');
  if (len) res.setHeader('content-length', len);
  if (!r.body) return res.end();
  Readable.fromWeb(r.body).pipe(res);
};

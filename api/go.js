// Vercel adapter: reuses the same proxy logic as the Netlify function, but streams big files
// straight to the browser instead of buffering them (so the ~4.5 MB response cap doesn't apply).
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { handler } = require('../netlify/functions/proxy');

const CHUNK = 256 * 1024;

// When a page's own script navigates to a path like /results?q=x (instead of through /go), the request lands on
// this site. The Referer tells us which proxied page it came from, so we can send it to the right place.
function refererTarget(req) {
  try {
    const r = new URL(req.headers.referer || '');
    return r.pathname === '/go' ? r.searchParams.get('u') : null;
  } catch { return null; }
}
function redirect(res, status, to) {
  res.statusCode = status;
  res.setHeader('location', to);
  res.setHeader('cache-control', 'no-store');
  res.end();
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const hasU = typeof q.u === 'string' && q.u;
  if (!hasU) {
    const from = refererTarget(req);
    if (!from) {
      res.statusCode = q.fbp !== undefined ? 404 : 400;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(q.fbp !== undefined ? 'Not found' : 'Nothing to load.');
      return;
    }
    const sp = new URLSearchParams();
    for (const k of Object.keys(q)) {
      if (k === 'fbp' || k === 'u' || k === 'vs') continue;
      for (const v of [].concat(q[k])) sp.append(k, v);
    }
    let abs;
    try {
      if (q.fbp !== undefined) abs = new URL(String(q.fbp || '/') + (sp.toString() ? '?' + sp : ''), from).href;
      else { const x = new URL(from); x.search = sp.toString(); x.hash = ''; abs = x.href; }
    } catch { res.statusCode = 400; res.end('Bad address'); return; }
    const ck = /(?:^|;\s*)vscheme=(dark|light)/.exec(req.headers.cookie || '');
    const vs = /^(dark|light)$/.test(q.vs || '') ? q.vs : ck ? ck[1] : '';
    return redirect(res, req.method === 'GET' || req.method === 'HEAD' ? 302 : 307, '/go?u=' + encodeURIComponent(abs) + (vs ? '&vs=' + vs : ''));
  }

  let body;
  if (req.method === 'POST' && req.body != null) {
    if (Buffer.isBuffer(req.body)) body = req.body.toString('base64');
    else if (typeof req.body === 'string') body = Buffer.from(req.body).toString('base64');
    else if (/json/i.test(req.headers['content-type'] || '')) body = Buffer.from(JSON.stringify(req.body)).toString('base64');
    else body = Buffer.from(new URLSearchParams(req.body).toString()).toString('base64');
  }
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: { u: req.query && req.query.u, vs: req.query && req.query.vs },
    body,
    isBase64Encoded: true,
    stream: true,
  };

  const out = await handler(event);
  res.statusCode = out.statusCode;
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);

  try {
    if (out.stream) {
      const src = Readable.fromWeb(out.stream);
      req.on('close', () => src.destroy()); // browser went away: stop downloading upstream
      await pipeline(src, res);
      return;
    }
    const data = out.isBase64Encoded ? Buffer.from(out.body, 'base64') : Buffer.from(out.body || '');
    if (data.length <= CHUNK * 8) { res.end(data); return; }
    // Large text/HTML: send in chunks so it streams.
    await pipeline(Readable.from((function* () { for (let i = 0; i < data.length; i += CHUNK) yield data.subarray(i, i + CHUNK); })()), res);
  } catch (e) {
    if (!res.writableEnded) res.destroy();
  }
};

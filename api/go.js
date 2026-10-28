// Vercel adapter: reuses the same proxy logic as the Netlify function, but streams big files
// straight to the browser instead of buffering them (so the ~4.5 MB response cap doesn't apply).
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');
const { handler } = require('../netlify/functions/proxy');

const CHUNK = 256 * 1024;

module.exports = async (req, res) => {
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
    queryStringParameters: { u: req.query && req.query.u },
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

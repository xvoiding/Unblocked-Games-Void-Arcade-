// Vercel adapter: reuses the same proxy logic as the Netlify function.
const { handler } = require('../netlify/functions/proxy');

module.exports = async (req, res) => {
  let body;
  if (req.method === 'POST' && req.body != null) {
    if (Buffer.isBuffer(req.body)) body = req.body.toString('base64');
    else if (typeof req.body === 'string') body = Buffer.from(req.body).toString('base64');
    else body = Buffer.from(new URLSearchParams(req.body).toString()).toString('base64');
  }
  const ct = req.headers['content-type'] || '';
  const event = {
    httpMethod: req.method,
    headers: req.headers,
    queryStringParameters: { u: req.query && req.query.u },
    body,
    isBase64Encoded: true,
  };
  // parsed JSON bodies are re-sent as form data above; keep the content-type consistent
  if (body && /json/i.test(ct)) { event.body = Buffer.from(JSON.stringify(req.body)).toString('base64'); }

  const out = await handler(event);
  res.status(out.statusCode);
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.send(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
};

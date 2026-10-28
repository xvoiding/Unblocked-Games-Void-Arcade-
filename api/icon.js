// Vercel adapter for the icon route (same logic as the Netlify function).
const { handler } = require('../netlify/functions/icon');

module.exports = async (req, res) => {
  const out = await handler({ queryStringParameters: { d: req.query && req.query.d } });
  res.status(out.statusCode);
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.send(out.isBase64Encoded ? Buffer.from(out.body, 'base64') : out.body);
};

// Vercel adapter for the AI route (same logic as the Netlify function).
const { handler } = require('../netlify/functions/ai');

module.exports = async (req, res) => {
  let body = req.body;
  if (body && typeof body !== 'string') body = JSON.stringify(body);
  const out = await handler({ httpMethod: req.method, headers: req.headers, body });
  res.status(out.statusCode);
  for (const [k, v] of Object.entries(out.headers || {})) res.setHeader(k, v);
  res.send(out.body);
};

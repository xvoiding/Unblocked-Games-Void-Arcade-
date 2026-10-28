// AI chat backend. Your API key never reaches the browser: set ANTHROPIC_API_KEY in your
// hosting dashboard (Vercel: Settings -> Environment Variables). Without it the AI tab just
// shows "not set up yet".
//
// Env vars (all optional except the key):
//   ANTHROPIC_API_KEY   your key from console.anthropic.com
//   AI_MODEL            default: claude-haiku-5-5 (fast + cheap)
//   AI_DAILY_LIMIT      max AI requests per day across everyone (default 400)
//   AI_IP_LIMIT         max requests per person per 5 minutes (default 12)

const MODEL = process.env.AI_MODEL || 'claude-haiku-5-5';
const API_VERSION = '2026-10-21';
const DAILY_LIMIT = Number(process.env.AI_DAILY_LIMIT) || 400;
const IP_LIMIT = Number(process.env.AI_IP_LIMIT) || 12;

const SYSTEM = [
  'You are Void AI, a friendly assistant built into a games and study hub.',
  'Keep answers clear and fairly short. When someone is learning, explain the idea and show the steps instead of only handing over the answer.',
  'Keep everything age-appropriate: no sexual content, graphic violence, or instructions for hurting people or breaking into systems.',
  'If someone seems to be struggling or in distress, be kind and encourage them to talk to a trusted adult or a local crisis line.',
].join(' ');

// Best-effort limits (memory is per server instance, which is fine for a small site).
const hits = new Map();
const day = { d: '', n: 0 };

const json = (statusCode, obj) => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(obj),
});

function clean(messages) {
  if (!Array.isArray(messages)) return null;
  const out = [];
  for (const m of messages.slice(-14)) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') continue;
    const content = m.content.slice(0, 3000).trim();
    if (!content) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.content += '\n' + content; // keep turns alternating
    else out.push({ role: m.role, content });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  if (!out.length || out[out.length - 1].role !== 'user') return null;
  return out;
}

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { error: 'bad_method', message: 'POST only.' });

  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return json(503, { error: 'not_configured', message: "The AI isn't set up yet. The site owner needs to add an ANTHROPIC_API_KEY." });
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return json(400, { error: 'bad_json', message: 'Bad request.' }); }
  const messages = clean(body.messages);
  if (!messages) return json(400, { error: 'bad_messages', message: 'Say something first.' });

  const ip = String((event.headers && (event.headers['x-forwarded-for'] || event.headers['x-real-ip'])) || 'unknown').split(',')[0].trim();
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 5 * 60 * 1000);
  if (recent.length >= IP_LIMIT) return json(429, { error: 'slow_down', message: 'Slow down a little, try again in a few minutes.' });
  const today = new Date().toISOString().slice(0, 10);
  if (day.d !== today) { day.d = today; day.n = 0; }
  if (day.n >= DAILY_LIMIT) return json(429, { error: 'daily_limit', message: 'The AI hit its limit for today. Try again tomorrow.' });
  recent.push(now); hits.set(ip, recent); day.n++;
  if (hits.size > 5000) hits.clear();

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': API_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({ model: MODEL, max_tokens: 700, system: SYSTEM, messages }),
      signal: AbortSignal.timeout(25000),
    });
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) return json(503, { error: 'bad_key', message: "The AI key isn't working. The site owner needs to check it." });
      if (r.status === 429 || r.status === 529) return json(503, { error: 'busy', message: 'The AI is busy right now. Try again in a moment.' });
      return json(502, { error: 'upstream', message: 'The AI had a problem. Try again.' });
    }
    const data = await r.json();
    const reply = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
    return json(200, { reply: reply || "I couldn't come up with a reply. Try asking another way." });
  } catch (e) {
    return json(504, { error: 'timeout', message: 'That took too long. Try a shorter question.' });
  }
};

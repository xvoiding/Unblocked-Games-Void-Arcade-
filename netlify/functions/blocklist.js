// Content filter used by the proxy. Server-side, so it can't be skipped from the browser.

// Domains blocked outright (the domain and all subdomains).
const BLOCKED_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com',
  'spankbang.com', 'eporner.com', 'tube8.com', 'motherless.com', 'thothub.to', 'erome.com',
  'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com',
  'cam4.com', 'livejasmin.com', 'brazzers.com', 'nhentai.net', 'hanime.tv', 'e621.net',
  'rule34.xxx', 'gelbooru.com', 'danbooru.donmai.us', 'bestgore.fun', 'kaotic.com',
  'liveleak.com', 'luscious.net', 'literotica.com', 'fapello.com', 'coomer.su', 'kemono.su',
];

// Long, unambiguous terms: blocked if they appear anywhere in a hostname, path or query.
const STRONG_SUBSTRINGS = [
  'porn', 'xxx', 'hentai', 'nsfw', 'onlyfans', 'xvideos', 'xnxx', 'xhamster', 'redtube',
  'youporn', 'spankbang', 'chaturbate', 'stripchat', 'bongacams', 'livejasmin', 'brazzers',
  'rule34', 'nhentai', 'hanime', 'eporner', 'fansly', 'motherless', 'thothub', 'bestgore',
  'camgirl', 'sexcam', 'nudist', 'erotica', 'upskirt', 'creampie', 'blowjob', 'handjob',
];

// Short terms: only blocked as whole words (so "essex" or "sussex" are fine).
const STRONG_TOKENS = new Set([
  'sex', 'sexy', 'nude', 'nudes', 'naked', 'nudity', 'erotic', 'fetish', 'bdsm', 'milf',
  'boobs', 'tits', 'nipples', 'escort', 'escorts', 'gore', 'camgirls', 'hookup', 'hookups',
  'topless', 'lingerie', 'stripper', 'strippers', 'onlyfan',
]);

const PRIVATE_V4 = [
  /^0\./, /^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
];

function tokens(str) {
  return str.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function hasBad(str) {
  const lower = str.toLowerCase();
  const flat = lower.replace(/[^a-z0-9]/g, '');
  for (const s of STRONG_SUBSTRINGS) if (flat.includes(s)) return s;
  for (const t of tokens(lower)) if (STRONG_TOKENS.has(t)) return t;
  return null;
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || !host.includes('.') && !host.includes(':')) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // IPv6 literals not allowed
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return PRIVATE_V4.some((r) => r.test(host)) || true; // no raw IPs at all
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

// Returns { ok: true } or { ok: false, reason }.
function checkUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'That address is not valid.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'Only web addresses are allowed.' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (isPrivateHost(host)) return { ok: false, reason: 'That address is not allowed.' };
  for (const d of BLOCKED_DOMAINS) {
    if (host === d || host.endsWith('.' + d)) return { ok: false, reason: 'This site is blocked (adult content).' };
  }
  if (hasBad(host)) return { ok: false, reason: 'This site is blocked (adult content).' };
  let rest = u.pathname + ' ' + u.search;
  try { rest = decodeURIComponent(rest); } catch { /* keep raw */ }
  if (hasBad(rest)) return { ok: false, reason: 'This page is blocked (adult content).' };
  return { ok: true };
}

// Scans an HTML response for adult-content markers.
function looksAdultHtml(html) {
  const head = html.slice(0, 60000);
  if (/RTA-5042-1996-1400-1577-RTA/i.test(head)) return true; // standard adult-site label
  if (/<meta[^>]+name=["']?rating["']?[^>]+content=["']?(adult|mature|rta)/i.test(head)) return true;
  if (/<meta[^>]+content=["']?(adult|mature|rta)[^>]+name=["']?rating/i.test(head)) return true;
  const title = (head.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  if (title && hasBad(title)) return true;
  const body = tokens(head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' '));
  let hits = 0;
  for (const t of body) if (STRONG_TOKENS.has(t) && t !== 'escort' && t !== 'gore') hits++;
  return hits >= 6;
}

module.exports = { checkUrl, looksAdultHtml, hasBad };

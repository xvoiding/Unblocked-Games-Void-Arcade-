// Void Arcade: Cloudflare proxy, shared by the Pages Function and the Worker.
//
// handleProxy(request, next): answers /go and /icon, anything else goes to next():
//   /go?u=<url>   streaming web proxy (no size cap; big files stream through, Range works)
//   /go/<url>     same thing, address in the path
//   /go/ping      health check
//   /icon?d=<dom> favicon route
//
// Same adult/gore content filter as the Netlify and Vercel versions, re-checked on every
// redirect hop. HTML is streamed through HTMLRewriter, so large pages don't hit the CPU limit.
// Not included: WebSockets. Only /go and /icon are routed here (see public/_routes.json).

// ---------------------------------------------------------------- content filter
const BLOCKED_DOMAINS = [
  'pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com',
  'spankbang.com', 'eporner.com', 'tube8.com', 'motherless.com', 'thothub.to', 'erome.com',
  'onlyfans.com', 'fansly.com', 'chaturbate.com', 'stripchat.com', 'bongacams.com',
  'cam4.com', 'livejasmin.com', 'brazzers.com', 'nhentai.net', 'hanime.tv', 'e621.net',
  'rule34.xxx', 'gelbooru.com', 'danbooru.donmai.us', 'bestgore.fun', 'kaotic.com',
  'liveleak.com', 'luscious.net', 'literotica.com', 'fapello.com', 'coomer.su', 'kemono.su',
];
const STRONG_SUBSTRINGS = [
  'porn', 'xxx', 'hentai', 'nsfw', 'onlyfans', 'xvideos', 'xnxx', 'xhamster', 'redtube',
  'youporn', 'spankbang', 'chaturbate', 'stripchat', 'bongacams', 'livejasmin', 'brazzers',
  'rule34', 'nhentai', 'hanime', 'eporner', 'fansly', 'motherless', 'thothub', 'bestgore',
  'camgirl', 'sexcam', 'nudist', 'erotica', 'upskirt', 'creampie', 'blowjob', 'handjob',
  'beheading', 'decapitat', 'dismember', 'mutilat', 'gorevideo', 'goresite', 'snuffvid', 'pornstar',
];
const STRONG_TOKENS = new Set([
  'sex', 'sexy', 'nude', 'nudes', 'naked', 'nudity', 'erotic', 'fetish', 'bdsm', 'milf',
  'boobs', 'tits', 'nipples', 'escort', 'escorts', 'gore', 'camgirls', 'hookup', 'hookups',
  'topless', 'lingerie', 'stripper', 'strippers', 'onlyfan',
  'gory', 'snuff', 'rape', 'rapist', 'incest', 'porno', 'xxxx', 'cumshot', 'orgy', 'gangbang',
  'beheaded', 'mutilated', 'bloodbath', 'dismembered',
]);

const tokens = (str) => str.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

function hasBad(str) {
  const lower = str.toLowerCase();
  const flat = lower.replace(/[^a-z0-9]/g, '');
  for (const s of STRONG_SUBSTRINGS) if (flat.includes(s)) return s;
  for (const t of tokens(lower)) if (STRONG_TOKENS.has(t)) return t;
  return null;
}

function isPrivateHost(host) {
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || (!host.includes('.') && !host.includes(':'))) return true;
  if (host.startsWith('[') || host.includes(':')) return true; // no IPv6 literals
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return true; // no raw IPs
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/i.test(host)) return true;
  return false;
}

function checkUrl(raw, selfHost) {
  let u;
  try { u = new URL(raw); } catch { return { ok: false, reason: 'That address is not valid.' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, reason: 'Only web addresses are allowed.' };
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (isPrivateHost(host) || (selfHost && host === selfHost)) return { ok: false, reason: 'That address is not allowed.' };
  for (const d of BLOCKED_DOMAINS) {
    if (host === d || host.endsWith('.' + d)) return { ok: false, reason: 'This site is blocked (adult content).' };
  }
  if (hasBad(host)) return { ok: false, reason: 'This site is blocked (adult content).' };
  let rest = u.pathname + ' ' + u.search;
  try { rest = decodeURIComponent(rest); } catch { /* keep raw */ }
  if (hasBad(rest)) return { ok: false, reason: 'This page is blocked (adult content).' };
  return { ok: true };
}

function looksAdultHtml(html) {
  const head = html.slice(0, 60000);
  if (/RTA-5042-1996-1400-1577-RTA/i.test(head)) return true;
  if (/<meta[^>]+name=["']?rating["']?[^>]+content=["']?(adult|mature|rta)/i.test(head)) return true;
  if (/<meta[^>]+content=["']?(adult|mature|rta)[^>]+name=["']?rating/i.test(head)) return true;
  const title = (head.match(/<title[^>]*>([^<]*)<\/title>/i) || [])[1] || '';
  if (title && hasBad(title)) return true;
  const body = tokens(head.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<[^>]+>/gi, ' '));
  let hits = 0;
  for (const t of body) if (STRONG_TOKENS.has(t) && t !== 'escort' && t !== 'gore') hits++;
  return hits >= 6;
}

// ---------------------------------------------------------------- helpers
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function infoPage(status, title, msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>html,body{height:100%;margin:0;background:#000;color:#fff;font:15px ui-monospace,Menlo,Consolas,monospace}
body{display:flex;align-items:center;justify-content:center;text-align:center}
div{max-width:420px;padding:24px;border:1px solid #333}h1{font-size:18px;margin:0 0 10px}p{color:#aaa;margin:0}</style>
<div><h1>${esc(title)}</h1><p>${esc(msg)}</p></div>`,
    { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

const prox = (abs) => '/go?u=' + encodeURIComponent(abs);

function absolutize(value, base) {
  const v = (value || '').trim();
  if (!v || v.startsWith('#') || /^(javascript|data|mailto|tel|blob|about):/i.test(v)) return null;
  try {
    const abs = new URL(v, base).href;
    return /^https?:/i.test(abs) ? abs : null;
  } catch { return null; }
}

function rewriteCss(css, base) {
  return css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, val) => {
    const abs = absolutize(val, base);
    return abs ? `url(${q}${prox(abs)}${q})` : m;
  });
}

function shim(base) {
  const B = JSON.stringify(base);
  return `<script>(function(){var B=${B};
function P(u){try{u=String(u);if(u.indexOf('/go?u=')===0)return u;var a=new URL(u,B).href;if(!/^https?:/.test(a))return u;return '/go?u='+encodeURIComponent(a);}catch(e){return u}}
var f=window.fetch;if(f){window.fetch=function(i,o){try{if(typeof i==='string'||i instanceof URL)i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);}catch(e){}return f.call(this,i,o)}}
var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=P(u);return x.apply(this,arguments)};
var w=window.open;window.open=function(u){return w.call(window,u?P(u):u)};
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(a&&a.getAttribute('href').indexOf('/go?u=')!==0){var h=a.getAttribute('href');if(/^https?:/i.test(h)){e.preventDefault();location.href=P(h)}}},true);
})();</script>`;
}

// Streams HTML through Cloudflare's HTMLRewriter (fast, low memory, no size cap).
function rewriteHtmlStream(res, base, headers) {
  let injected = false;
  const inject = (el) => { if (!injected) { injected = true; el.prepend(shim(base), { html: true }); } };
  const URL_ATTRS = ['href', 'src', 'action', 'poster', 'data-src'];
  let styleBuf = '';

  const rw = new HTMLRewriter()
    .on('base', { element(el) { el.remove(); } })
    .on('meta[http-equiv]', {
      element(el) {
        const v = (el.getAttribute('http-equiv') || '').toLowerCase();
        if (v === 'content-security-policy' || v === 'refresh') el.remove();
      },
    })
    .on('[href],[src],[action],[poster],[data-src],[srcset],[integrity],[nonce],[crossorigin]', {
      element(el) {
        el.removeAttribute('integrity');
        el.removeAttribute('nonce');
        el.removeAttribute('crossorigin');
        for (const a of URL_ATTRS) {
          const v = el.getAttribute(a);
          if (v == null) continue;
          const abs = absolutize(v, base);
          if (abs) el.setAttribute(a, prox(abs));
        }
        const ss = el.getAttribute('srcset');
        if (ss != null) {
          el.setAttribute('srcset', ss.split(',').map((p) => {
            const [u, ...rest] = p.trim().split(/\s+/);
            const abs = absolutize(u, base);
            return (abs ? prox(abs) : u) + (rest.length ? ' ' + rest.join(' ') : '');
          }).join(', '));
        }
      },
    })
    .on('style', {
      text(t) {
        styleBuf += t.text;
        if (t.lastInTextNode) { t.replace(rewriteCss(styleBuf, base), { html: true }); styleBuf = ''; }
        else t.remove();
      },
    })
    .on('head', { element: inject })
    .on('body', { element: inject });

  return rw.transform(new Response(res.body, { status: res.status, headers }));
}

// Reads roughly the first 60 KB of a stream so the adult-content scan can run
// before anything is sent to the browser. Returns { text, stream } where stream is the full body.
async function peek(stream, limit = 65536) {
  const [a, b] = stream.tee();
  const reader = a.getReader();
  const dec = new TextDecoder('utf-8', { fatal: false });
  let text = '', size = 0;
  while (size < limit) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    text += dec.decode(value, { stream: true });
  }
  reader.cancel().catch(() => {});
  return { text, stream: b };
}

// ---------------------------------------------------------------- /go
async function handleGo(request, url, selfHost, override) {
  const target = override || url.searchParams.get('u');
  if (!target) return infoPage(400, 'No address', 'Nothing to load.');

  let method = request.method === 'POST' ? 'POST' : request.method === 'HEAD' ? 'HEAD' : 'GET';
  let body = method === 'POST' ? await request.arrayBuffer() : undefined;
  const headers = new Headers({
    'user-agent': UA,
    accept: request.headers.get('accept') || '*/*',
    'accept-language': request.headers.get('accept-language') || 'en-US,en;q=0.9',
  });
  if (body && request.headers.get('content-type')) headers.set('content-type', request.headers.get('content-type'));
  const range = request.headers.get('range');
  if (range) headers.set('range', range);

  let cur = target, res = null;
  try {
    for (let hop = 0; hop < 8; hop++) {
      const check = checkUrl(cur, selfHost);
      if (!check.ok) return infoPage(403, 'Blocked', check.reason);
      res = await fetch(cur, { method, headers, body, redirect: 'manual' });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        cur = new URL(loc, cur).href;
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; headers.delete('content-type'); }
        res = null;
        continue;
      }
      break;
    }
  } catch (e) {
    return infoPage(502, "Couldn't load that", 'The site took too long or refused the connection.');
  }
  if (!res) return infoPage(508, 'Too many redirects', 'That site kept bouncing the request around.');

  const ct = res.headers.get('content-type') || 'application/octet-stream';
  const out = new Headers({ 'content-type': ct, 'cache-control': 'no-store' });

  try {
    // HTML: scan the start for adult content, then stream it through the rewriter.
    if (/text\/html|application\/xhtml/i.test(ct)) {
      const { text, stream } = await peek(res.body);
      if (looksAdultHtml(text)) return infoPage(403, 'Blocked', 'This page looks like adult content.');
      return rewriteHtmlStream({ body: stream, status: res.status }, cur, out);
    }
    // CSS: small, rewrite url(...) references.
    if (/text\/css/i.test(ct)) {
      return new Response(rewriteCss(await res.text(), cur), { status: res.status, headers: out });
    }
    // Everything else streams straight through, any size. Range/partial content is preserved.
    for (const h of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = res.headers.get(h);
      if (v) out.set(h, v);
    }
    // The body is already decompressed, so only keep the upstream length if it wasn't compressed.
    const len = res.headers.get('content-length');
    if (len && !res.headers.get('content-encoding')) out.set('content-length', len);
    out.set('cache-control', 'private, max-age=600');
    return new Response(method === 'HEAD' ? null : res.body, { status: res.status, headers: out });
  } catch (e) {
    return infoPage(502, "Couldn't load that", 'Something went wrong reading the response.');
  }
}

// ---------------------------------------------------------------- /icon
async function handleIcon(url, selfHost) {
  const d = String(url.searchParams.get('d') || '').toLowerCase();
  if (!/^[a-z0-9.-]{3,80}$/.test(d) || !d.includes('.') || !checkUrl('https://' + d, selfHost).ok) {
    return new Response('', { status: 400, headers: { 'cache-control': 'no-store' } });
  }
  const sources = [
    `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${d}.ico`,
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src, { cf: { cacheTtl: 604800, cacheEverything: true } });
      if (!r.ok) continue;
      const buf = await r.arrayBuffer();
      if (buf.byteLength < 100) continue;
      return new Response(buf, {
        headers: {
          'content-type': r.headers.get('content-type') || 'image/png',
          'cache-control': 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400',
        },
      });
    } catch (e) { /* try next */ }
  }
  return new Response('', { status: 404, headers: { 'cache-control': 'public, max-age=3600' } });
}

// ---------------------------------------------------------------- entry
export async function handleProxy(request, next) {
  const url = new URL(request.url);
  const selfHost = url.hostname.toLowerCase();
  const p = url.pathname;

  if (p === '/icon') return handleIcon(url, selfHost);

  if (p === '/go/ping' || p === '/go/ping/') {
    return new Response('proxy ok', { headers: { 'content-type': 'text/plain', 'cache-control': 'no-store' } });
  }
  if (request.method === 'OPTIONS' && (p === '/go' || p.startsWith('/go/'))) {
    return new Response(null, { status: 204, headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET,POST,HEAD,OPTIONS', 'access-control-allow-headers': '*' } });
  }
  if (p === '/go') return handleGo(request, url, selfHost);
  if (p.startsWith('/go/')) {
    // /go/<encoded address> (older link style)
    let raw = p.slice(4);
    try { raw = decodeURIComponent(raw); } catch { /* keep raw */ }
    raw = raw.replace(/^(https?):\/+/i, '$1://');
    if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
    return handleGo(request, url, selfHost, raw + url.search);
  }
  return next();
}

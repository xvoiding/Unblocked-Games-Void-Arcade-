// Simple server-side web proxy for Netlify Functions.
// GET/POST /go?u=<encoded url>  ->  fetches the page, rewrites links back through /go.
// Limits (Netlify): ~10s per request, ~6MB per response, no WebSockets.

const { checkUrl, looksAdultHtml } = require('./blocklist');

const MAX_BYTES = (process.env.VERCEL ? 4.2 : 5.5) * 1024 * 1024; // Vercel caps responses at 4.5MB
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function infoPage(status, title, msg) {
  return {
    statusCode: status,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
    body: `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>
<style>html,body{height:100%;margin:0;background:#000;color:#fff;font:15px ui-monospace,Menlo,Consolas,monospace}
body{display:flex;align-items:center;justify-content:center;text-align:center}
div{max-width:420px;padding:24px;border:1px solid #333}h1{font-size:18px;margin:0 0 10px}p{color:#aaa;margin:0}</style>
<div><h1>${esc(title)}</h1><p>${esc(msg)}</p></div>`,
  };
}

const prox = (abs) => '/go?u=' + encodeURIComponent(abs);

function absolutize(value, base) {
  const v = value.trim();
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
function P(u){try{u=String(u);if(!u)return u;if(u.indexOf('/go?u=')===0)return u;var a=new URL(u,B).href;if(!/^https?:/.test(a))return u;return '/go?u='+encodeURIComponent(a);}catch(e){return u}}
var f=window.fetch;if(f){window.fetch=function(i,o){try{if(typeof i==='string'||i instanceof URL)i=P(i);else if(i&&i.url)i=new Request(P(i.url),i);}catch(e){}return f.call(this,i,o)}}
var x=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=P(u);return x.apply(this,arguments)};
var w=window.open;window.open=function(u){return w.call(window,u?P(u):u)};
var W=window.Worker;if(W){window.Worker=function(u,o){return new W(P(u),o)};window.Worker.prototype=W.prototype}
function pp(p,n){if(!p)return;var d=Object.getOwnPropertyDescriptor(p,n);if(!d||!d.set)return;
Object.defineProperty(p,n,{configurable:true,enumerable:d.enumerable,get:d.get,set:function(v){try{d.set.call(this,P(v))}catch(e){d.set.call(this,v)}}})}
pp(window.HTMLScriptElement&&HTMLScriptElement.prototype,'src');
pp(window.HTMLImageElement&&HTMLImageElement.prototype,'src');
pp(window.HTMLSourceElement&&HTMLSourceElement.prototype,'src');
pp(window.HTMLMediaElement&&HTMLMediaElement.prototype,'src');
pp(window.HTMLLinkElement&&HTMLLinkElement.prototype,'href');
pp(window.HTMLEmbedElement&&HTMLEmbedElement.prototype,'src');
pp(window.HTMLIFrameElement&&HTMLIFrameElement.prototype,'src');
document.addEventListener('click',function(e){var a=e.target.closest&&e.target.closest('a[href]');if(a&&a.getAttribute('href').indexOf('/go?u=')!==0){var h=a.getAttribute('href');if(/^https?:/i.test(h)){e.preventDefault();location.href=P(h)}}},true);
})();</script>`;
}

function rewriteHtml(html, base) {
  let out = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)[^>]*>/gi, '')
    .replace(/\s(integrity|nonce|crossorigin)\s*=\s*(["']).*?\2/gi, '')
    .replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => {
      const abs = absolutize(val, base);
      return abs ? `${pre}${q}${prox(abs)}${q}` : m;
    })
    .replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => {
      const parts = val.split(',').map((p) => {
        const [u, ...rest] = p.trim().split(/\s+/);
        const abs = absolutize(u, base);
        return (abs ? prox(abs) : u) + (rest.length ? ' ' + rest.join(' ') : '');
      });
      return `${pre}${q}${parts.join(', ')}${q}`;
    })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => rewriteCss(m, base));
  const tag = shim(base);
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + tag) : tag + out;
  return out;
}

exports.handler = async (event) => {
  const target = event.queryStringParameters && event.queryStringParameters.u;
  if (!target) return infoPage(400, 'No address', 'Nothing to load.');

  let method = event.httpMethod === 'POST' ? 'POST' : 'GET';
  let body = method === 'POST' && event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  const headers = { 'user-agent': UA, accept: event.headers.accept || '*/*', 'accept-language': event.headers['accept-language'] || 'en-US,en;q=0.9' };
  if (body && event.headers['content-type']) headers['content-type'] = event.headers['content-type'];

  let url = target, res;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const check = checkUrl(url);
      if (!check.ok) return infoPage(403, 'Blocked', check.reason);
      res = await fetch(url, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(8500) });
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        url = new URL(loc, url).href;
        if (res.status !== 307 && res.status !== 308) { method = 'GET'; body = undefined; delete headers['content-type']; }
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
  const outHeaders = { 'content-type': ct, 'cache-control': 'no-store' };

  try {
    if (/text\/html|application\/xhtml/i.test(ct)) {
      const html = await res.text();
      if (looksAdultHtml(html)) return infoPage(403, 'Blocked', 'This page looks like adult content.');
      return { statusCode: res.status, headers: outHeaders, body: rewriteHtml(html, url) };
    }
    if (/text\/css/i.test(ct)) {
      return { statusCode: res.status, headers: outHeaders, body: rewriteCss(await res.text(), url) };
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return infoPage(413, 'Too big', 'That file is too large to pass through the proxy.');
    if (/^text\/|json|javascript|xml/i.test(ct)) return { statusCode: res.status, headers: outHeaders, body: buf.toString('utf8') };
    return { statusCode: res.status, headers: outHeaders, body: buf.toString('base64'), isBase64Encoded: true };
  } catch (e) {
    return infoPage(502, "Couldn't load that", 'Something went wrong reading the response.');
  }
};

exports.rewriteHtml = rewriteHtml;

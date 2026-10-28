// Simple server-side web proxy for Netlify Functions.
// GET/POST /go?u=<encoded url>  ->  fetches the page, rewrites links back through /go.
// Netlify: responses are buffered (~6MB cap, ~10s). Vercel: non-HTML files stream straight through
// (event.stream = true), so large files work; only the time limit in vercel.json applies. No WebSockets.

const { checkUrl, looksAdultHtml } = require('./blocklist');

const MAX_BYTES = 5.5 * 1024 * 1024; // only used in buffered mode (Netlify)
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
try{var NS='vx|'+new URL(B).origin+'|';
function wrapS(real){function keys(){var a=[];for(var i=0;i<real.length;i++){var k=real.key(i);if(k&&k.indexOf(NS)===0)a.push(k.slice(NS.length))}return a}
var api={getItem:function(k){return real.getItem(NS+k)},setItem:function(k,v){real.setItem(NS+k,v)},removeItem:function(k){real.removeItem(NS+k)},clear:function(){keys().forEach(function(k){real.removeItem(NS+k)})},key:function(i){var a=keys();return i>=0&&i<a.length?a[i]:null}};
return new Proxy(api,{get:function(t,p){if(p==='length')return keys().length;if(typeof p==='string'&&!(p in t)){var v=t.getItem(p);return v===null?undefined:v}return t[p]},set:function(t,p,v){t.setItem(String(p),v);return true},deleteProperty:function(t,p){t.removeItem(String(p));return true},has:function(t,p){return p in t||keys().indexOf(p)>-1},ownKeys:function(){return keys()},getOwnPropertyDescriptor:function(t,p){var v=t.getItem(String(p));return v===null?undefined:{value:v,writable:true,enumerable:true,configurable:true}}})}
var LS=wrapS(window.localStorage),SS=wrapS(window.sessionStorage);
Object.defineProperty(window,'localStorage',{configurable:true,get:function(){return LS}});
Object.defineProperty(window,'sessionStorage',{configurable:true,get:function(){return SS}});
if(window.IDBFactory){var Fo=IDBFactory.prototype.open,Fd=IDBFactory.prototype.deleteDatabase,Fs=IDBFactory.prototype.databases;
IDBFactory.prototype.open=function(n){var a=[].slice.call(arguments);a[0]=NS+n;return Fo.apply(this,a)};
IDBFactory.prototype.deleteDatabase=function(n){var a=[].slice.call(arguments);a[0]=NS+n;return Fd.apply(this,a)};
if(Fs)IDBFactory.prototype.databases=function(){return Fs.call(this).then(function(l){return l.filter(function(d){return d.name&&d.name.indexOf(NS)===0}).map(function(d){return{name:d.name.slice(NS.length),version:d.version}})})}}
}catch(e){}
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

// Decodes a text response using its real charset (header, then <meta charset>), defaulting to UTF-8.
async function decodeText(res, ct) {
  const buf = Buffer.from(await res.arrayBuffer());
  let label = (/charset\s*=\s*["']?([\w-]+)/i.exec(ct) || [])[1];
  if (!label) {
    const sniff = buf.subarray(0, 4096).toString('latin1');
    label = (/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(sniff) || [])[1];
  }
  try { return new TextDecoder(label || 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

exports.handler = async (event) => {
  const target = event.queryStringParameters && event.queryStringParameters.u;
  if (!target) return infoPage(400, 'No address', 'Nothing to load.');

  let method = event.httpMethod === 'POST' ? 'POST' : 'GET';
  let body = method === 'POST' && event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  const headers = { 'user-agent': UA, accept: event.headers.accept || '*/*', 'accept-language': event.headers['accept-language'] || 'en-US,en;q=0.9' };
  if (body && event.headers['content-type']) headers['content-type'] = event.headers['content-type'];
  if (event.headers.range) headers.range = event.headers.range;

  let url = target, res;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const check = checkUrl(url);
      if (!check.ok) return infoPage(403, 'Blocked', check.reason);
      // The timer only covers waiting for the response headers, so big downloads aren't cut off.
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 8500);
      try { res = await fetch(url, { method, headers, body, redirect: 'manual', signal: ac.signal }); }
      finally { clearTimeout(timer); }
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
      const html = await decodeText(res, ct);
      if (looksAdultHtml(html)) return infoPage(403, 'Blocked', 'This page looks like adult content.');
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      return { statusCode: res.status, headers: outHeaders, body: rewriteHtml(html, url) };
    }
    if (/text\/css/i.test(ct)) {
      outHeaders['content-type'] = 'text/css; charset=utf-8';
      return { statusCode: res.status, headers: outHeaders, body: rewriteCss(await decodeText(res, ct), url) };
    }

    // Everything else is passed through untouched. Keep range/partial-content info so big media can seek.
    const passHeaders = { 'content-type': ct, 'cache-control': 'private, max-age=600' };
    for (const h of ['content-range', 'accept-ranges', 'etag', 'last-modified']) {
      const v = res.headers.get(h);
      if (v) passHeaders[h] = v;
    }
    // fetch() already decompressed the body, so the upstream length is only valid if it wasn't compressed.
    const len = res.headers.get('content-length');
    if (len && !res.headers.get('content-encoding')) passHeaders['content-length'] = len;

    if (event.stream && res.body) {
      return { statusCode: res.status, headers: passHeaders, stream: res.body }; // no size cap
    }
    delete passHeaders['content-length'];
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_BYTES) return infoPage(413, 'Too big', 'That file is too large to pass through the proxy.');
    if (/^text\/|json|javascript|xml/i.test(ct)) return { statusCode: res.status, headers: passHeaders, body: buf.toString('utf8') };
    return { statusCode: res.status, headers: passHeaders, body: buf.toString('base64'), isBase64Encoded: true };
  } catch (e) {
    return infoPage(502, "Couldn't load that", 'Something went wrong reading the response.');
  }
};

exports.rewriteHtml = rewriteHtml;

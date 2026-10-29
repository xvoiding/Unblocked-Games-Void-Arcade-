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

// Ad and tracker hosts are answered instantly with an empty response instead of being fetched.
// That makes pages load faster, saves proxy time, and keeps the site ad-free.
const TRACKERS = [
  'doubleclick.net', 'googlesyndication.com', 'googleadservices.com', 'googletagservices.com', 'googletagmanager.com',
  'google-analytics.com', 'adservice.google.com', 'pagead2.googlesyndication.com', 'adnxs.com', 'adsrvr.org', 'taboola.com',
  'outbrain.com', 'criteo.com', 'criteo.net', 'scorecardresearch.com', 'quantserve.com', 'amazon-adsystem.com',
  'moatads.com', 'pubmatic.com', 'rubiconproject.com', 'openx.net', 'casalemedia.com', '2mdn.net', 'adform.net',
  'smartadserver.com', 'adsafeprotected.com', 'imrworldwide.com', 'hotjar.com', 'bat.bing.com', 'clarity.ms',
  'connect.facebook.net', 'ads-twitter.com', 'analytics.tiktok.com', 'adroll.com', 'mathtag.com', 'bidswitch.net',
];
function isTracker(url) {
  try {
    const h = new URL(url).hostname.toLowerCase();
    return TRACKERS.some((d) => h === d || h.endsWith('.' + d));
  } catch { return false; }
}
function trackerStub(url) {
  const headers = { 'cache-control': 'public, max-age=86400, s-maxage=86400' };
  if (/\.js(\?|$)|\/gtm\.js|\/analytics\.js|\/gtag\//i.test(url)) {
    return { statusCode: 200, headers: { ...headers, 'content-type': 'application/javascript; charset=utf-8' }, body: '/* blocked */' };
  }
  return { statusCode: 204, headers, body: '' };
}

// Static files are the same for everyone (no cookies are forwarded), so the CDN can keep them.
const CACHE_STATIC = 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=86400';
const CACHE_PAGE = 'private, max-age=120';

const hostOf = (u) => { try { return new URL(u).hostname; } catch { return ''; } };
const prox = (abs, scheme) => '/go?u=' + encodeURIComponent(abs) + (scheme ? '&vs=' + scheme : '');

// The site's theme decides whether pages should think the browser is in dark or light mode.
// The page sets a "vscheme" cookie; here we rewrite (prefers-color-scheme: dark|light) so it is always true for
// the chosen scheme and always false for the other one.
const SCHEME_RE = /\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi;
const schemeCss = (s, sc) => (sc ? s.replace(SCHEME_RE, (m, v) => (v.toLowerCase() === sc ? '(min-width:0px)' : '(max-width:0px)')) : s);
function schemeOf(h) {
  const m = /(?:^|;\s*)vscheme=(dark|light)/.exec((h && h.cookie) || '');
  return m ? m[1] : '';
}

const isYt = (h) => /(^|\.)youtube\.com$/i.test(h || '');

function absolutize(value, base) {
  const v = value.trim();
  if (!v || v.startsWith('#') || /^(javascript|data|mailto|tel|blob|about):/i.test(v)) return null;
  try {
    const abs = new URL(v, base).href;
    return /^https?:/i.test(abs) ? abs : null;
  } catch { return null; }
}

function rewriteCss(css, base, scheme) {
  return schemeCss(css.replace(/url\(\s*(['"]?)(.*?)\1\s*\)/gi, (m, q, val) => {
    const abs = absolutize(val, base);
    return abs ? `url(${q}${prox(abs, scheme)}${q})` : m;
  }), scheme);
}

function shim(base, scheme) {
  const B = JSON.stringify(base);
  const SC = JSON.stringify(scheme || '');
  return `<script>(function(){var B=${B},SC=${SC};
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
var LAST=B;
function CURF(){try{var s=new URLSearchParams(location.search).get('u');if(s){LAST=s;return s}}catch(e){}return LAST}
function P(u){try{u=String(u);if(!u)return u;if(u.indexOf('/go?u=')===0)return u;var x=new URL(u,CURF());if(x.origin===location.origin){if(x.pathname==='/go'&&x.searchParams.get('u'))return x.pathname+x.search+x.hash;x=new URL(x.pathname+x.search+x.hash,CURF())}var a=x.href;if(!/^https?:/.test(a))return u;return '/go?u='+encodeURIComponent(a)+(SC?'&vs='+SC:'');}catch(e){return u}}
if(SC&&window.matchMedia){var mm=window.matchMedia.bind(window);window.matchMedia=function(q){return mm(String(q).replace(/\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)/gi,function(_,v){return v.toLowerCase()===SC?'(min-width:0px)':'(max-width:0px)'}))}}
var HP=window.History&&History.prototype||history,hp=HP.pushState,hr=HP.replaceState;
function HH(fn){return function(s,t,u){if(u!=null&&u!==''){var x=String(u);if(x.charAt(0)!=='#')try{u=P(x)}catch(e){}}return fn.call(this,s,t,u)}}
HP.pushState=HH(hp);HP.replaceState=HH(hr);
// Some sites (YouTube) change the address with a clean copy of the history API that we can't wrap. If the address
// stops being /go?u=..., put the real address back so reloads and links keep working.
function FIX(){try{if(location.pathname==='/go'&&new URLSearchParams(location.search).get('u'))return;
var abs=new URL(location.pathname+location.search+location.hash,LAST).href;if(!/^https?:/.test(abs))return;
hr.call(history,history.state,'','/go?u='+encodeURIComponent(abs)+(SC?'&vs='+SC:''))}catch(e){}}
setInterval(FIX,250);
try{if(window.navigation)navigation.addEventListener('currententrychange',FIX)}catch(e){}
function FS(f,sub){try{
var fa=sub&&sub.hasAttribute&&sub.hasAttribute('formaction');
var m=String((sub&&sub.getAttribute&&sub.getAttribute('formmethod'))||f.getAttribute('method')||'get').toLowerCase();
var act=(fa?sub.getAttribute('formaction'):f.getAttribute('action'))||'',real='';
if(act.indexOf('/go?u=')===0){real=new URL(act,location.href).searchParams.get('u')||''}
if(!real)real=new URL(act,CURF()).href;
if(!/^https?:/.test(real))return false;
if(m==='post'){if(act.indexOf('/go?u=')!==0)(fa?sub:f).setAttribute(fa?'formaction':'action',P(real));return false}
var u=new URL(real);u.search='';
new FormData(f).forEach(function(v,k){if(typeof v==='string')u.searchParams.append(k,v)});
if(sub&&sub.name&&!u.searchParams.has(sub.name))u.searchParams.append(sub.name,sub.value||'');
location.href=P(u.href);return true}catch(e){return false}}
document.addEventListener('submit',function(e){var f=e.target;if(f&&f.tagName==='FORM'&&!e.defaultPrevented&&FS(f,e.submitter))e.preventDefault()},true);
var fsub=HTMLFormElement.prototype.submit;HTMLFormElement.prototype.submit=function(){if(!FS(this,null))fsub.call(this)};
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
document.addEventListener('click',function(e){
if(e.defaultPrevented||e.button!==0)return;
var a=e.target.closest&&e.target.closest('a[href]');if(!a||a.hasAttribute('download'))return;
var h=a.getAttribute('href');
if(!h||h.charAt(0)==='#'||h.indexOf('/go?u=')===0||/^(javascript|mailto|tel|data|blob|about):/i.test(h))return;
var x;try{x=new URL(h,CURF()).href}catch(er){return}
if(!/^https?:/.test(x))return;
e.preventDefault();e.stopPropagation();
if(a.getAttribute('target')==='_blank'||e.ctrlKey||e.metaKey||e.shiftKey)window.open(P(x));else location.href=P(x);
},true);
})();</script>`;
}

function rewriteHtml(html, base, scheme) {
  let out = html
    .replace(/<base\b[^>]*>/gi, '')
    .replace(/<meta[^>]+name=["']?referrer["']?[^>]*>/gi, '')
    .replace(/<meta[^>]+http-equiv=["']?(content-security-policy|refresh)[^>]*>/gi, '')
    .replace(/\s(integrity|nonce|crossorigin)\s*=\s*(["']).*?\2/gi, '')
    .replace(/(\s(?:href|src|action|poster|data-src)\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => {
      const abs = absolutize(val, base);
      return abs ? `${pre}${q}${prox(abs, scheme)}${q}` : m;
    })
    .replace(/(\ssrcset\s*=\s*)(["'])(.*?)\2/gi, (m, pre, q, val) => {
      const parts = val.split(',').map((p) => {
        const [u, ...rest] = p.trim().split(/\s+/);
        const abs = absolutize(u, base);
        return (abs ? prox(abs, scheme) : u) + (rest.length ? ' ' + rest.join(' ') : '');
      });
      return `${pre}${q}${parts.join(', ')}${q}`;
    })
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, (m) => rewriteCss(m, base, scheme));
  const tag = shim(base, scheme);
  out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + tag) : tag + out;
  return schemeCss(out, scheme);
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
  const qs = event.queryStringParameters || {};
  const scheme = /^(dark|light)$/.test(qs.vs || '') ? qs.vs : schemeOf(event.headers);

  let method = event.httpMethod === 'POST' ? 'POST' : 'GET';
  let body = method === 'POST' && event.body ? (event.isBase64Encoded ? Buffer.from(event.body, 'base64') : event.body) : undefined;
  const headers = { 'user-agent': UA, accept: event.headers.accept || '*/*', 'accept-language': event.headers['accept-language'] || 'en-US,en;q=0.9' };
  if (body && event.headers['content-type']) headers['content-type'] = event.headers['content-type'];
  if (event.headers.range) headers.range = event.headers.range;
  // YouTube and its video servers expect to be talked to by youtube.com, so present ourselves that way.
  const th = hostOf(target);
  if (isYt(th) || /(^|\.)(googlevideo\.com|googleapis\.com|ytimg\.com|ggpht\.com|gstatic\.com)$/i.test(th)) {
    const dest = event.headers['sec-fetch-dest'] || '';
    headers.referer = 'https://www.youtube.com/';
    if (dest !== 'document' && dest !== 'iframe' && dest !== 'image' && dest !== 'style' && dest !== 'script') headers.origin = 'https://www.youtube.com';
    if (isYt(th)) headers.cookie = (scheme === 'light' ? 'PREF=hl=en' : 'PREF=f6=400&hl=en') + '; SOCS=CAI; CONSENT=YES+1';
    for (const k of Object.keys(event.headers)) if (/^x-(goog|youtube)-/i.test(k)) headers[k] = event.headers[k];
  }

  let url = target, res;
  try {
    for (let hop = 0; hop < 6; hop++) {
      const check = checkUrl(url);
      if (!check.ok) return infoPage(403, 'Blocked', check.reason);
      if (isTracker(url)) return trackerStub(url);
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
  const canCache = method === 'GET' && event.httpMethod !== 'POST' && res.status === 200 && !event.headers.range;
  const outHeaders = { 'content-type': ct, 'cache-control': canCache ? CACHE_PAGE : 'no-store' };

  try {
    if (/text\/html|application\/xhtml/i.test(ct)) {
      const html = await decodeText(res, ct);
      if (looksAdultHtml(html)) return infoPage(403, 'Blocked', 'This page looks like adult content.');
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      return { statusCode: res.status, headers: outHeaders, body: rewriteHtml(html, url, scheme) };
    }
    if (/text\/css/i.test(ct)) {
      outHeaders['content-type'] = 'text/css; charset=utf-8';
      const css = await decodeText(res, ct);
      if (canCache) outHeaders['cache-control'] = CACHE_STATIC; // the scheme is part of the URL, so each scheme caches separately
      return { statusCode: res.status, headers: outHeaders, body: rewriteCss(css, url, scheme) };
    }

    // Everything else is passed through untouched. Keep range/partial-content info so big media can seek.
    const passHeaders = { 'content-type': ct, 'cache-control': canCache ? CACHE_STATIC : 'private, max-age=600' };
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

// api/go.js — streaming reverse proxy (Vercel, Node runtime)
export const config = { maxDuration: 60 };

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const PASS = ['content-type', 'content-length', 'accept-ranges', 'content-range', 'last-modified', 'etag'];

function esc(s) {
  return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function targetUrl(req) {
  const u = new URL(req.url);
  const viaQuery = u.searchParams.get('u');
  let raw = viaQuery ? viaQuery : u.pathname.replace(/^\/go\/?/, '') + u.search;
  if (!raw) return null;
  try { raw = decodeURIComponent(raw); } catch (e) {}
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw;
  try { new URL(raw); } catch (e) { return null; }
  return raw;
}

function resolve(v, base) {
  if (v == null) return v;
  v = String(v).trim();
  if (!v || /^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(v)) return v;
  try {
    const abs = new URL(v, base).href;
    return /^https?:/i.test(abs) ? '/go/' + abs : abs;
  } catch (e) { return v; }
}

function rewriteCss(css, base) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, v) => `url(${q}${resolve(v, base)}${q})`)
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, v) => `@import ${q}${resolve(v, base)}${q}`);
}

function shim(base) {
  return `<script>(function(){
var B=${JSON.stringify(base)};
function R(u){
  try{
    if(u==null)return u;
    u=String(u).trim();
    if(!u||/^(data:|blob:|javascript:|about:|mailto:|tel:|#)/i.test(u))return u;
    var a=new URL(u,B).href;
    return /^https?:/i.test(a)?'/go/'+a:a;
  }catch(e){return u}
}
window.__pv=R;
var sa=Element.prototype.setAttribute;
Element.prototype.setAttribute=function(n,v){
  if(/^(src|href|action|poster|formaction|data-src|data-href)$/i.test(n)&&typeof v==='string')v=R(v);
  return sa.call(this,n,v);
};
function pp(P,ps){ps.forEach(function(p){
  var d=Object.getOwnPropertyDescriptor(P,p);
  if(!d||!d.set)return;
  Object.defineProperty(P,p,{configurable:true,enumerable:d.enumerable,
    get:function(){return d.get.call(this)},set:function(v){d.set.call(this,R(v))}});
})}
pp(HTMLScriptElement.prototype,['src']);
pp(HTMLImageElement.prototype,['src','srcset']);
pp(HTMLMediaElement.prototype,['src']);
pp(HTMLSourceElement.prototype,['src','srcset']);
pp(HTMLLinkElement.prototype,['href']);
pp(HTMLEmbedElement.prototype,['src']);
pp(HTMLIFrameElement.prototype,['src']);
pp(HTMLFormElement.prototype,['action']);
var f=window.fetch;
if(f)window.fetch=function(i,o){
  try{
    if(typeof i==='string')i=R(i);
    else if(i&&i.url)i=new Request(R(i.url),i);
  }catch(e){}
  return f.call(this,i,o);
};
var X=window.XMLHttpRequest,op=X.prototype.open;
X.prototype.open=function(m,u){try{arguments[1]=R(u)}catch(e){}return op.apply(this,arguments)};
var wo=window.open;
window.open=function(u){try{u=R(u)}catch(e){}return wo.apply(window,arguments)};
if(window.Worker){var W=window.Worker;window.Worker=function(u,o){return new W(R(u),o)};window.Worker.prototype=W.prototype}
if(window.importScripts){var isc=window.importScripts;window.importScripts=function(){return isc.apply(this,[].map.call(arguments,R))}}
})();</script>`;
}

function rewriteHtml(html, base) {
  html = String(html).replace(/<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi, '');
  html = html.replace(/\s(src|href|action|poster|formaction|data-src|data-href)\s*=\s*(["'])([^"']*)\2/gi,
    (m, a, q, v) => ` ${a}=${q}${resolve(v, base)}${q}`);
  html = html.replace(/\s(srcset)\s*=\s*(["'])([^"']*)\2/gi, (m, a, q, v) => {
    const out = v.split(',').map(s => {
      const p = s.trim().split(/\s+/);
      return resolve(p[0], base) + (p[1] ? ' ' + p[1] : '');
    }).join(', ');
    return ` ${a}=${q}${out}${q}`;
  });
  html = html.replace(/<style([^>]*)>([\s\S]*?)<\/style>/gi, (m, a, c) => `<style${a}>${rewriteCss(c, base)}</style>`);
  html = html.replace(/style\s*=\s*(["'])([^"']*)\1/gi, (m, q, v) => `style=${q}${rewriteCss(v, base)}${q}`);
  const inject = `<base href="${base}">${shim(base)}`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head([^>]*)>/i, (m, a) => `<head${a}>${inject}`);
  if (/<html[^>]*>/i.test(html)) return html.replace(/<html([^>]*)>/i, (m, a) => `<html${a}><head>${inject}</head>`);
  return inject + html;
}

function fail(status, msg) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><body style="font:13px/1.6 ui-monospace,monospace;background:#0b0b12;color:#e9e9f2;padding:22px;word-break:break-all">
     <h3 style="margin:0 0 10px;color:#ff6b81">Proxy ${status}</h3><p style="opacity:.75;margin:0">${esc(msg)}</p></body>`,
    { status: status >= 400 && status < 600 ? status : 502,
      headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } }
  );
}

export default async function handler(req) {
  const target = targetUrl(req);
  if (!target) return fail(400, 'No target URL. Use /go/https://example.com/page.html');

  const h = {
    'user-agent': UA,
    'accept': req.headers.get('accept') || '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'accept-encoding': 'identity',
    'referer': new URL(target).origin + '/'
  };
  const range = req.headers.get('range');
  if (range) h.range = range;

  let up;
  try {
    up = await fetch(target, { method: req.method === 'HEAD' ? 'HEAD' : 'GET', headers: h, redirect: 'follow' });
  } catch (e) {
    return fail(502, target + '\n' + (e && e.message ? e.message : e));
  }
  if (up.status >= 400) return fail(up.status, 'Upstream returned ' + up.status + ' for ' + target);

  const ct = (up.headers.get('content-type') || '').toLowerCase();
  const finalUrl = up.url || target;
  const dir = new URL('.', finalUrl).href;

  if (req.method === 'HEAD') {
    const oh = new Headers();
    if (ct) oh.set('content-type', ct);
    const cl = up.headers.get('content-length');
    if (cl) oh.set('content-length', cl);
    return new Response(null, { status: up.status, headers: oh });
  }

  if (ct.includes('text/html') || ct.includes('application/xhtml')) {
    return new Response(rewriteHtml(await up.text(), dir), {
      status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  if (ct.includes('text/css')) {
    return new Response(rewriteCss(await up.text(), dir), {
      status: 200, headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-store' }
    });
  }

  const oh = new Headers();
  for (const k of PASS) {
    const v = up.headers.get(k);
    if (v) oh.set(k, v);
  }
  if (!ct) oh.set('content-type', 'application/octet-stream');
  oh.set('cache-control', 'public, max-age=86400');
  return new Response(up.body, { status: up.status, headers: oh });
}

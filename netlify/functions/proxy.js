function shim(base) {
  const B = JSON.stringify(base);
  return `<script>(function(){var B=${B};
function P(u){try{u=String(u);if(u.indexOf('/go?u=')===0)return u;var a=new URL(u,B).href;if(!/^https?:/.test(a))return u;return '/go?u='+encodeURIComponent(a);}catch(e){return u}}
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

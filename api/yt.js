// YouTube data for the in-browser YouTube page (public/yt.html), fetched from a Piped instance.
// Searches and results go through the same adult-content filter as the proxy.
//   GET /api/yt?a=trending
//   GET /api/yt?a=search&q=...[&page=<token>]
//   GET /api/yt?a=streams&v=<id>
const { hasBad } = require('../netlify/functions/blocklist');

const API = 'https://api.piped.private.coffee';
const MEDIA_HOST = /(^|\.)piped\.private\.coffee$/i;

function send(res, status, obj, cache) {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', cache || 'no-store');
  res.end(JSON.stringify(obj));
}

// Thumbnails and video files come from the Piped media proxy; send them through this site's /m route.
function media(u) {
  try {
    const x = new URL(u);
    if (MEDIA_HOST.test(x.hostname)) return '/m' + x.pathname + x.search;
  } catch { /* leave as is */ }
  return u || '';
}

const idOf = (u) => {
  const m = /[?&]v=([\w-]{6,20})/.exec(u || '');
  return m ? m[1] : '';
};

function clean(items) {
  const out = [];
  for (const it of items || []) {
    if (!it || (it.type && it.type !== 'stream')) continue;
    const id = idOf(it.url);
    if (!id) continue;
    const title = String(it.title || '');
    const by = String(it.uploaderName || '');
    if (hasBad(title + ' ' + by + ' ' + String(it.shortDescription || '').slice(0, 200))) continue;
    out.push({
      id,
      title,
      by,
      views: it.views >= 0 ? it.views : null,
      dur: it.duration >= 0 ? it.duration : null,
      when: it.uploadedDate || '',
      thumb: media(it.thumbnail),
      short: !!it.isShort,
    });
  }
  return out;
}

async function piped(path) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), 9000);
  try {
    const r = await fetch(API + path, { signal: ac.signal, headers: { 'user-agent': 'Mozilla/5.0 VoidArcade', accept: 'application/json' } });
    if (!r.ok) throw new Error('upstream ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

module.exports = async (req, res) => {
  const q = req.query || {};
  const a = String(q.a || '');
  try {
    if (a === 'trending') {
      const d = await piped('/trending?region=US');
      return send(res, 200, { items: clean(d) }, 'public, max-age=300, s-maxage=600');
    }
    if (a === 'search') {
      const term = String(q.q || '').trim().slice(0, 200);
      if (!term) return send(res, 200, { items: [] });
      if (hasBad(term)) return send(res, 200, { blocked: true, items: [] });
      const tok = String(q.page || '');
      const d = tok
        ? await piped('/nextpage/search?nextpage=' + encodeURIComponent(tok) + '&q=' + encodeURIComponent(term) + '&filter=videos')
        : await piped('/search?q=' + encodeURIComponent(term) + '&filter=videos');
      return send(res, 200, { items: clean(d.items), next: d.nextpage || null }, 'public, max-age=120, s-maxage=300');
    }
    if (a === 'streams') {
      const v = String(q.v || '');
      if (!/^[\w-]{6,20}$/.test(v)) return send(res, 400, { error: 'bad id' });
      const d = await piped('/streams/' + v);
      const text = [d.title, d.uploader, String(d.description || '').slice(0, 400), (d.tags || []).slice(0, 15).join(' ')].join(' ');
      if (hasBad(text)) return send(res, 200, { blocked: true });
      const vids = (d.videoStreams || [])
        .filter((s) => s && s.videoOnly === false && /video\/(mp4|webm)/i.test(s.mimeType || ''))
        .map((s) => ({ url: media(s.url), q: s.quality || '', mime: s.mimeType, h: s.height || parseInt(s.quality, 10) || 0 }))
        .sort((x, y) => y.h - x.h);
      return send(res, 200, {
        id: v,
        title: d.title || '',
        by: d.uploader || '',
        views: d.views >= 0 ? d.views : null,
        dur: d.duration >= 0 ? d.duration : null,
        when: d.uploadDate || '',
        desc: String(d.description || '').replace(/<[^>]+>/g, ' ').slice(0, 700),
        live: !!d.livestream,
        videos: vids,
        related: clean(d.relatedStreams).slice(0, 16),
      }, 'private, max-age=60');
    }
    return send(res, 400, { error: 'unknown action' });
  } catch (e) {
    return send(res, 502, { error: 'YouTube data is unavailable right now. Try again in a moment.' });
  }
};

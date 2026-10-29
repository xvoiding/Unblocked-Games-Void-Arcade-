// YouTube search proxy for the Music page. The API key lives in the YOUTUBE_API_KEY environment
// variable (Vercel > Project Settings > Environment Variables), never in the page or the repo.
// Results are cached at the edge so repeat searches don't use up the daily quota.
const G = 'https://www.googleapis.com/youtube/v3';
const GENRE_Q = {
  'Lo-Fi': 'lofi hip hop music', 'Hip-Hop': 'hip hop music', Pop: 'pop music', Rock: 'rock music',
  'R&B': 'r&b music', Electronic: 'electronic music', Chill: 'chill music', Gaming: 'gaming music',
};

function iso(d) {
  const m = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(d || '');
  return m ? (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0) : 0;
}
const dec = (s) => String(s || '').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
const clean = (s) => dec(s).replace(/ - Topic$/, '').replace(/VEVO$/i, '').trim();

async function g(path, params, key) {
  const u = new URL(G + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('key', key);
  const r = await fetch(u, { headers: { accept: 'application/json' } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const reason = (j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason) || '';
    const e = new Error(reason || 'upstream');
    e.status = r.status; e.reason = reason;
    throw e;
  }
  return j;
}

module.exports = async (req, res) => {
  res.setHeader('content-type', 'application/json; charset=utf-8');
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) { res.status(503).setHeader('cache-control', 'no-store'); return res.end(JSON.stringify({ error: 'no_key' })); }
  try {
    const q = String((req.query && req.query.q) || '').trim().slice(0, 100);
    const genre = String((req.query && req.query.genre) || '');
    let ids = [];
    let sn = {};
    if (q || GENRE_Q[genre]) {
      const j = await g('/search', {
        part: 'snippet', type: 'video', videoCategoryId: '10', videoEmbeddable: 'true', videoSyndicated: 'true',
        safeSearch: 'strict', maxResults: '25', q: q || GENRE_Q[genre],
      }, key);
      for (const it of j.items || []) { if (it.id && it.id.videoId) { ids.push(it.id.videoId); sn[it.id.videoId] = it.snippet || {}; } }
    } else {
      const j = await g('/videos', { part: 'snippet,contentDetails', chart: 'mostPopular', videoCategoryId: '10', regionCode: 'US', maxResults: '25' }, key);
      const out = (j.items || []).map((v) => ({ id: v.id, title: dec(v.snippet.title), artist: clean(v.snippet.channelTitle), dur: iso(v.contentDetails && v.contentDetails.duration) }));
      res.setHeader('cache-control', 'public, s-maxage=3600, stale-while-revalidate=86400');
      return res.status(200).end(JSON.stringify({ data: out }));
    }
    let durs = {}, ok = {};
    if (ids.length) {
      const j = await g('/videos', { part: 'contentDetails,status', id: ids.join(',') }, key);
      for (const v of j.items || []) { durs[v.id] = iso(v.contentDetails && v.contentDetails.duration); ok[v.id] = !(v.status && v.status.embeddable === false); }
    }
    const out = ids.filter((id) => ok[id]).map((id) => ({ id, title: dec(sn[id].title) || 'Untitled', artist: clean(sn[id].channelTitle), dur: durs[id] || 0 }));
    res.setHeader('cache-control', 'public, s-maxage=21600, stale-while-revalidate=86400');
    res.status(200).end(JSON.stringify({ data: out }));
  } catch (e) {
    res.setHeader('cache-control', 'no-store');
    const quota = e.reason === 'quotaExceeded' || e.reason === 'dailyLimitExceeded' || e.status === 429;
    res.status(quota ? 429 : 502).end(JSON.stringify({ error: quota ? 'quota' : e.reason === 'keyInvalid' || e.status === 400 ? 'bad_key' : 'upstream' }));
  }
};

// Serves a site's favicon from your own domain: /icon?d=example.com
// Same-origin, so it keeps working even if third-party icon hosts are filtered. Cached hard.

const { checkUrl } = require('./blocklist');

exports.handler = async (event) => {
  const d = String((event.queryStringParameters && event.queryStringParameters.d) || '').toLowerCase();
  if (!/^[a-z0-9.-]{3,80}$/.test(d) || !d.includes('.') || !checkUrl('https://' + d).ok) {
    return { statusCode: 400, headers: { 'cache-control': 'no-store' }, body: '' };
  }
  const sources = [
    `https://www.google.com/s2/favicons?domain=${d}&sz=128`,
    `https://icons.duckduckgo.com/ip3/${d}.ico`,
  ];
  for (const src of sources) {
    try {
      const r = await fetch(src, { signal: AbortSignal.timeout(4000) });
      if (!r.ok) continue;
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length < 100) continue;
      return {
        statusCode: 200,
        headers: {
          'content-type': r.headers.get('content-type') || 'image/png',
          'cache-control': 'public, max-age=604800, s-maxage=2592000, stale-while-revalidate=86400',
        },
        body: buf.toString('base64'),
        isBase64Encoded: true,
      };
    } catch (e) { /* try next source */ }
  }
  return { statusCode: 404, headers: { 'cache-control': 'public, max-age=3600' }, body: '' };
};

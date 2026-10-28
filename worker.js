// Cloudflare Worker entry (Workers + static assets). Serves the site from ./public and
// runs the proxy for /go and /icon (see wrangler.jsonc and ../proxy/core.js).
import { handleProxy } from './proxy/core.js';

export default {
  fetch(request, env) {
    return handleProxy(request, () => env.ASSETS.fetch(request));
  },
};

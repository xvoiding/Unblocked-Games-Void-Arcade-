// Cloudflare Pages Function: runs the shared proxy (see ../proxy/core.js).
import { handleProxy } from '../proxy/core.js';

export const onRequest = (ctx) => handleProxy(ctx.request, () => ctx.next());

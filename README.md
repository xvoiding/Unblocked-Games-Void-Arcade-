# Void Arcade

Dark, clean games hub with a hidden browse bar. Static site + one Netlify Function.

## Deploy (2 minutes)

1. Push this folder to a GitHub repo (or drag the whole folder onto https://app.netlify.com/drop — the function needs the repo/CLI route, drag-and-drop skips functions).
2. Netlify → Add new site → Import from Git → pick the repo. Settings are already in `netlify.toml`, no build command needed.
3. Optional: rename the site or add a custom domain (Site settings → Domain management).

CLI route: `npm i -g netlify-cli && netlify deploy --prod`

## Using it

- **Browse bar:** press `` ` `` (backtick) or `Ctrl+K`, or click the logo 5 times. Type a URL or a search and hit Enter.
- **Panic:** tap `Esc` twice fast → jumps to Google Classroom.
- **Tab cloak:** footer dropdown changes the tab title + icon.
- **about:blank:** footer button opens the site inside a blank tab.
- **Direct / Proxy:** inside any game, the toggle switches between loading the site directly or through the proxy.

## Content filter

The proxy (`netlify/functions/blocklist.js`) blocks adult sites three ways:
1. A domain blocklist (add more to `BLOCKED_DOMAINS`).
2. Keyword checks on the hostname, path and query string.
3. A scan of each page's HTML (adult-site RTA label, rating meta tags, title, word counts).

Searches go through DuckDuckGo with strict SafeSearch on. Local/private addresses are blocked too. The filter runs on the server, so it can't be skipped from the browser.

No filter is perfect. Add terms/domains to the file as you find gaps.

## Adding games

Drop any HTML5 game folder into `public/games/` and add an entry to the `GAMES` array in `public/index.html` with `local:1`. Games hosted on your own domain load every time, no proxy needed.

## Limits (Netlify Functions)

- 10 second timeout, ~6 MB per response.
- No WebSockets, so multiplayer `.io` games and anything needing a live connection won't work in Proxy mode (try Direct).
- Sites with heavy logins/anti-bot (Roblox, Google) often won't work through the proxy.
- Netlify's free plan has bandwidth caps and its terms restrict abuse; heavy proxy traffic can get a site paused.

## Deploy on Vercel instead

1. Push the folder to GitHub.
2. https://vercel.com/new → import the repo → Deploy. `vercel.json` already sets the `public` folder and routes `/go` to `api/go.js`, so no settings to change.
3. CLI route: `npm i -g vercel && vercel --prod`

Vercel limits: 10s function timeout and 4.5 MB per response on the free (Hobby) plan, no WebSockets, and Hobby is for non-commercial use.

## What's on the site

- **Games**: 9 built-in games (Merge, Blocks, Flap, Dash, Snake, Breakout, Pong, Sweeper, Memory) that run on your own domain, plus links to big game sites. Built-ins always work.
- **AI**: chat assistant (see below).
- **Music**: ad-free SomaFM radio streams plus a focus mixer (rain, wind, brown noise, soft keys) generated in the browser.
- **Settings**: accent color, particles, calm mode, tab disguise, default Proxy/Direct for outside sites.
- No ads, no trackers.

## Turning on the AI tab

1. Get a key at https://console.anthropic.com and **set a monthly spend limit there** (every message costs a little).
2. Vercel: Project → Settings → Environment Variables → add `ANTHROPIC_API_KEY`, then redeploy. (Netlify: Site settings → Environment variables.)
3. Optional variables: `AI_MODEL` (default `claude-haiku-5-5`), `AI_DAILY_LIMIT` (default 400 requests/day for the whole site), `AI_IP_LIMIT` (default 12 per person per 5 minutes).

Without a key the AI tab simply says it isn't set up yet. The key stays on the server and never reaches the browser.

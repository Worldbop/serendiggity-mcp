#!/usr/bin/env node
/** Open GitHub notifications or a specific repo */
const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';
const target = process.argv[2] || 'https://github.com/notifications';

async function main() {
  const r = await fetch(`${BASE}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ url: target, pageId: 'github' }),
  }).then(r => r.json());
  console.log(r.ok ? `GitHub: ${r.title}` : r.error);
}
main().catch(e => console.error(e.message));

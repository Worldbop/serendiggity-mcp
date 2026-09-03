#!/usr/bin/env node
/** Open Outlook in a named browser tab */
const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

async function main() {
  const r = await fetch(`${BASE}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ url: 'https://outlook.live.com/mail/', pageId: 'email' }),
  }).then(r => r.json());
  console.log(r.ok ? `Email open: ${r.title}` : r.error);
}
main().catch(e => console.error(e.message));

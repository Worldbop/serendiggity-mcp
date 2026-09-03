#!/usr/bin/env node
/** Google search from the command line, results appear in browser */
const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';
const query = process.argv.slice(2).join(' ');

if (!query) { console.log('Usage: search.js <query>'); process.exit(1); }

async function main() {
  const r = await fetch(`${BASE}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      pageId: 'search',
    }),
  }).then(r => r.json());
  console.log(r.ok ? `Search: ${r.title}` : r.error);
}
main().catch(e => console.error(e.message));

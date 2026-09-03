#!/usr/bin/env node
/** Open Azure portal to the Serendiggity resource group */
const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

async function main() {
  const r = await fetch(`${BASE}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({
      url: 'https://portal.azure.com/#@platformserendiggity.onmicrosoft.com/resource/subscriptions/59f94479-bd34-4f67-bbdc-825c82955827/resourceGroups/rg-serendiggity-dev/overview',
      pageId: 'azure',
    }),
  }).then(r => r.json());
  console.log(r.ok ? `Azure: ${r.title}` : r.error);
}
main().catch(e => console.error(e.message));

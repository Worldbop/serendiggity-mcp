#!/usr/bin/env node
/** Open Serendiggity or Agent Comms app in the browser */
const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

const apps = {
  sdig: 'https://dev.serendiggity.com',
  comms: 'https://agentcomms.io',
  health: 'https://dev.serendiggity.com/api/health',
  local: 'http://localhost:3000',
  'local-comms': 'http://localhost:4300',
};

const target = process.argv[2] || 'sdig';
const url = apps[target] || target;

async function main() {
  const r = await fetch(`${BASE}/navigate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    body: JSON.stringify({ url, pageId: target }),
  }).then(r => r.json());
  console.log(r.ok ? `${target}: ${r.title} — ${r.url}` : r.error);
}
main().catch(e => console.error(e.message));

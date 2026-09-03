#!/usr/bin/env node
/**
 * Quick browser command — fire-and-forget from any terminal.
 *
 * Usage:
 *   node scripts/browse.js open https://github.com
 *   node scripts/browse.js click "Sign in"
 *   node scripts/browse.js type "#search" "serendiggity"
 *   node scripts/browse.js screenshot
 *   node scripts/browse.js content ".main-content"
 *   node scripts/browse.js eval "document.title"
 *   node scripts/browse.js press Enter
 *   node scripts/browse.js pages
 *
 * Set BROWSER_PROXY_URL for remote machines:
 *   BROWSER_PROXY_URL=http://192.168.1.100:3500 node scripts/browse.js open https://google.com
 */

const BASE = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

const [,, cmd, ...rawArgs] = process.argv;

// Extract --page <id> from args (works with any command)
let pageId = 'default';
const args = [];
for (let i = 0; i < rawArgs.length; i++) {
  if (rawArgs[i] === '--page' && rawArgs[i + 1]) {
    pageId = rawArgs[++i];
  } else {
    args.push(rawArgs[i]);
  }
}

async function call(endpoint, body, method = 'POST') {
  const res = await fetch(`${BASE}${endpoint}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': KEY },
    ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
  });
  return res.json();
}

async function main() {
  switch (cmd) {
    case 'open':
    case 'navigate':
    case 'go': {
      // browse.js open <url> [pageId]  OR  browse.js open <url> --page <id>
      const pid = args[1] || pageId;
      const r = await call('/navigate', { url: args[0], pageId: pid });
      console.log(r.ok ? `${r.title} — ${r.url}` : r.error);
      break;
    }
    case 'click': {
      const isSelector = args[0]?.startsWith('.') || args[0]?.startsWith('#') || args[0]?.startsWith('[');
      const r = await call('/click', { ...(isSelector ? { selector: args[0] } : { text: args[0] }), pageId });
      console.log(r.ok ? `Clicked → ${r.url}` : r.error);
      break;
    }
    case 'type': {
      const r = await call('/type', { selector: args[0], text: args[1], pageId });
      console.log(r.ok ? 'Typed' : r.error);
      break;
    }
    case 'screenshot':
    case 'ss': {
      const r = await call('/screenshot', { pageId, fullPage: args.includes('--full') });
      if (r.ok) {
        const fs = await import('fs');
        const path = args.find(a => a.endsWith('.png')) || 'screenshot.png';
        fs.writeFileSync(path, Buffer.from(r.image, 'base64'));
        console.log(`Saved ${path} — ${r.title}`);
      } else {
        console.log(r.error);
      }
      break;
    }
    case 'content':
    case 'text': {
      const r = await call('/content', { selector: args[0] || 'body', pageId });
      console.log(r.ok ? r.text : r.error);
      break;
    }
    case 'eval':
    case 'js': {
      const r = await call('/eval', { script: args.join(' '), pageId });
      console.log(r.ok ? r.result : r.error);
      break;
    }
    case 'press':
    case 'key': {
      const r = await call('/press', { key: args[0], selector: args[1], pageId });
      console.log(r.ok ? `Pressed ${args[0]}` : r.error);
      break;
    }
    case 'pages':
    case 'tabs': {
      const r = await call('/pages', {}, 'GET');
      r.pages.forEach(p => console.log(`${p.id}: ${p.url} — "${p.title}"`));
      break;
    }
    case 'close': {
      const r = await call('/close', { pageId: args[0] });
      console.log(r.ok ? 'Closed' : r.error);
      break;
    }
    default:
      console.log(`Usage: browse.js <open|click|type|screenshot|content|eval|press|pages|close> [args...]`);
  }
}

main().catch(e => console.error(e.message));

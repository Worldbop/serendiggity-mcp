import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';
import db, {
  getConfig, setConfig, getAllConfig,
  getAgents, setAgentStatus,
  ensureConversation, addMessage, getMessages,
  getRecentConversations,
} from './db.js';

// ── Local WebSocket relay for communicator app ───────────────────

const WS_PORT = parseInt(process.env.COMMS_WS_PORT || '9800', 10);
const wsClients = new Set();
let wss = null;
let relayOwner = false;  // true if THIS process owns the relay

function startRelay() {
  try {
    wss = new WebSocketServer({ port: WS_PORT, host: '0.0.0.0' });
  } catch (err) {
    process.stderr.write(`[comms-relay] Port ${WS_PORT} in use — running MCP tools without relay (another instance owns it)\n`);
    return;
  }

  wss.on('listening', () => {
    relayOwner = true;
    process.stderr.write(`[comms-relay] WebSocket listening on ws://0.0.0.0:${WS_PORT}\n`);
  });

  wss.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(`[comms-relay] Port ${WS_PORT} in use — running MCP tools without relay (another instance owns it)\n`);
      wss = null;
    } else {
      process.stderr.write(`[comms-relay] Error: ${err.message}\n`);
    }
  });

  wss.on('connection', (ws) => {
    wsClients.add(ws);
    process.stderr.write(`[comms-relay] Client connected (${wsClients.size} total)\n`);

    // Send current state on connect
    ws.send(JSON.stringify({
      type: 'sync',
      agents: getAgents(),
      conversations: getRecentConversations(20),
      config: Object.fromEntries(getAllConfig().map(c => [c.key, c.value])),
    }));

    ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleAppMessage(msg, ws);
      } catch { /* ignore malformed */ }
    });

    ws.on('close', () => {
      wsClients.delete(ws);
      process.stderr.write(`[comms-relay] Client disconnected (${wsClients.size} total)\n`);
    });
  });
}

startRelay();

function broadcast(event, excludeWs = null) {
  if (!relayOwner) return; // Another instance owns the relay — skip broadcast
  const payload = JSON.stringify(event);
  for (const client of wsClients) {
    if (client !== excludeWs && client.readyState === 1) {
      client.send(payload);
    }
  }
}

function handleAppMessage(msg, senderWs) {
  switch (msg.type) {
    case 'send_message': {
      const { attendees, from, body } = msg;
      const allAttendees = [...new Set(attendees)].sort();
      const key = allAttendees.join('|');
      ensureConversation(key, allAttendees);
      const id = randomUUID();
      addMessage(key, id, from, body);
      broadcast({
        type: 'new_message',
        conversationKey: key,
        message: { id, from_agent: from, body, created_at: new Date().toISOString() },
      });
      break;
    }
    case 'set_status': {
      setAgentStatus(msg.agentId, msg.status);
      broadcast({ type: 'agent_status', agentId: msg.agentId, status: msg.status });
      break;
    }
    case 'get_messages': {
      const messages = getMessages(msg.conversationKey, msg.limit || 50);
      senderWs.send(JSON.stringify({ type: 'messages', conversationKey: msg.conversationKey, messages }));
      break;
    }
    case 'get_agents': {
      senderWs.send(JSON.stringify({ type: 'agents', agents: getAgents() }));
      break;
    }
  }
}

// ── MCP Server ───────────────────────────────────────────────────

const server = new McpServer({
  name: 'agent-comms',
  version: '1.0.0',
});

// ── Tools ──────────────────────────────────────────────────────────

server.tool(
  'send_message',
  'Send a message in a conversation. Attendees are agent IDs (e.g. michael, mustafa, senior). The conversation is created or resumed based on the unique combination of attendees.',
  {
    attendees: z.array(z.string()).describe('Agent IDs in this conversation (your ID is auto-included)'),
    body: z.string().describe('Message text'),
  },
  async ({ attendees, body }) => {
    const myId = getConfig('agent_id') || 'senior';
    const allAttendees = [...new Set([myId, ...attendees])].sort();
    const key = allAttendees.join('|');
    ensureConversation(key, allAttendees);
    const id = randomUUID();
    addMessage(key, id, myId, body);

    // Broadcast to connected communicator apps
    broadcast({
      type: 'new_message',
      conversationKey: key,
      message: { id, from_agent: myId, body, created_at: new Date().toISOString() },
    });

    return {
      content: [{ type: 'text', text: `Message sent to [${allAttendees.join(', ')}] (conv: ${key})` }],
    };
  }
);

server.tool(
  'read_messages',
  'Read recent messages from a conversation. Specify attendees to identify which conversation.',
  {
    attendees: z.array(z.string()).describe('Agent IDs in the conversation'),
    limit: z.number().optional().default(25).describe('Max messages to return'),
  },
  async ({ attendees, limit }) => {
    const myId = getConfig('agent_id') || 'senior';
    const allAttendees = [...new Set([myId, ...attendees])].sort();
    const key = allAttendees.join('|');
    const messages = getMessages(key, limit);

    if (messages.length === 0) {
      return { content: [{ type: 'text', text: `No messages in conversation [${allAttendees.join(', ')}]` }] };
    }

    const formatted = messages.map(m =>
      `[${m.created_at}] ${m.from_agent}: ${m.body}`
    ).join('\n');

    return { content: [{ type: 'text', text: formatted }] };
  }
);

server.tool(
  'list_agents',
  'List all agents and their current status.',
  {},
  async () => {
    const agents = getAgents();
    const lines = agents.map(a =>
      `${a.id} | ${a.name} | ${a.role} | ${a.status} | last: ${a.last_seen || 'never'}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'set_status',
  'Update your agent status (online, busy, offline).',
  {
    status: z.enum(['online', 'busy', 'offline']).describe('New status'),
  },
  async ({ status }) => {
    const myId = getConfig('agent_id') || 'senior';
    setAgentStatus(myId, status);

    // Broadcast status change to communicator apps
    broadcast({ type: 'agent_status', agentId: myId, status });

    return { content: [{ type: 'text', text: `Status set to ${status}` }] };
  }
);

server.tool(
  'list_conversations',
  'List recent conversations with their attendees and last activity.',
  {
    limit: z.number().optional().default(10),
  },
  async ({ limit }) => {
    const convs = getRecentConversations(limit);
    if (convs.length === 0) {
      return { content: [{ type: 'text', text: 'No conversations yet.' }] };
    }

    const lines = convs.map(c =>
      `[${c.last_active}] ${c.attendees} — key: ${c.key}`
    );
    return { content: [{ type: 'text', text: lines.join('\n') }] };
  }
);

server.tool(
  'get_config',
  'Get a configuration value from the local SQLite database.',
  {
    key: z.string().describe('Config key (agent_id, gateway_url, api_base_url, openai_api_key, etc.)'),
  },
  async ({ key }) => {
    const value = getConfig(key);
    return { content: [{ type: 'text', text: value ?? `(not set: ${key})` }] };
  }
);

server.tool(
  'set_config',
  'Set a configuration value in the local SQLite database.',
  {
    key: z.string().describe('Config key'),
    value: z.string().describe('Config value'),
  },
  async ({ key, value }) => {
    setConfig(key, value);
    return { content: [{ type: 'text', text: `Config ${key} = ${value}` }] };
  }
);

server.tool(
  'show_dashboard',
  'Get a summary dashboard of agent status, recent conversations, and config.',
  {},
  async () => {
    const agents = getAgents();
    const convs = getRecentConversations(5);
    const config = getAllConfig();
    const myId = getConfig('agent_id') || 'senior';

    let text = `=== Agent Comms Dashboard ===\n`;
    text += `Identity: ${myId}\n`;
    text += `WebSocket relay: ws://localhost:${WS_PORT}\n`;
    text += `Connected clients: ${wsClients.size}\n\n`;

    text += `--- Agents ---\n`;
    for (const a of agents) {
      const marker = a.id === myId ? ' (you)' : '';
      text += `  ${a.status === 'online' ? '[*]' : '[ ]'} ${a.name} — ${a.role}${marker}\n`;
    }

    text += `\n--- Recent Conversations ---\n`;
    if (convs.length === 0) {
      text += '  (none)\n';
    } else {
      for (const c of convs) {
        text += `  ${JSON.parse(c.attendees).join(', ')} — ${c.last_active}\n`;
      }
    }

    text += `\n--- Config ---\n`;
    for (const c of config) {
      const display = c.key.includes('key') ? '***' : c.value;
      text += `  ${c.key}: ${display}\n`;
    }

    return { content: [{ type: 'text', text }] };
  }
);

// ── Resources ────────────────────────────────────────────────────

server.resource(
  'config',
  'comms://config',
  async (uri) => {
    const config = getAllConfig();
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(Object.fromEntries(config.map(c => [c.key, c.value]))),
      }],
    };
  }
);

server.resource(
  'agents',
  'comms://agents',
  async (uri) => {
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(getAgents()),
      }],
    };
  }
);

// ── Browser Proxy Tools ──────────────────────────────────────────
// These call the browser-proxy.js HTTP server (Playwright-powered).
// Any connected agent can control a real browser on this or remote machines.

const BROWSER_PROXY = process.env.BROWSER_PROXY_URL || 'http://localhost:3500';
const BROWSER_KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

async function browserCall(endpoint, body = {}) {
  const res = await fetch(`${BROWSER_PROXY}${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Api-Key': BROWSER_KEY },
    body: JSON.stringify(body),
  });
  return res.json();
}

server.tool(
  'browser_navigate',
  'Open a URL in a real browser. Use pageId to manage multiple tabs.',
  {
    url: z.string().describe('URL to navigate to'),
    pageId: z.string().optional().default('default').describe('Tab identifier'),
  },
  async ({ url, pageId }) => {
    const result = await browserCall('/navigate', { url, pageId });
    return { content: [{ type: 'text', text: result.ok ? `Opened ${result.url} — "${result.title}"` : `Error: ${result.error}` }] };
  }
);

server.tool(
  'browser_screenshot',
  'Take a screenshot of the current browser page. Returns base64 PNG.',
  {
    pageId: z.string().optional().default('default'),
    fullPage: z.boolean().optional().default(false),
  },
  async ({ pageId, fullPage }) => {
    const result = await browserCall('/screenshot', { pageId, fullPage });
    if (!result.ok) return { content: [{ type: 'text', text: `Error: ${result.error}` }] };
    return { content: [
      { type: 'text', text: `Screenshot of "${result.title}" (${result.url})` },
      { type: 'image', data: result.image, mimeType: 'image/png' },
    ] };
  }
);

server.tool(
  'browser_click',
  'Click an element on the page by CSS selector or visible text.',
  {
    selector: z.string().optional().describe('CSS selector'),
    text: z.string().optional().describe('Visible text to click'),
    pageId: z.string().optional().default('default'),
  },
  async ({ selector, text, pageId }) => {
    const result = await browserCall('/click', { selector, text, pageId });
    return { content: [{ type: 'text', text: result.ok ? `Clicked → now at ${result.url}` : `Error: ${result.error}` }] };
  }
);

server.tool(
  'browser_type',
  'Type text into an input field.',
  {
    selector: z.string().describe('CSS selector of the input'),
    text: z.string().describe('Text to type'),
    pageId: z.string().optional().default('default'),
    clear: z.boolean().optional().default(true).describe('Clear field first'),
  },
  async ({ selector, text, pageId, clear }) => {
    const result = await browserCall('/type', { selector, text, pageId, clear });
    return { content: [{ type: 'text', text: result.ok ? 'Typed successfully' : `Error: ${result.error}` }] };
  }
);

server.tool(
  'browser_content',
  'Get the text content of the page or a specific element.',
  {
    selector: z.string().optional().default('body'),
    pageId: z.string().optional().default('default'),
  },
  async ({ selector, pageId }) => {
    const result = await browserCall('/content', { selector, pageId });
    return { content: [{ type: 'text', text: result.ok ? result.text : `Error: ${result.error}` }] };
  }
);

server.tool(
  'browser_eval',
  'Execute JavaScript on the current page.',
  {
    script: z.string().describe('JavaScript to execute'),
    pageId: z.string().optional().default('default'),
  },
  async ({ script, pageId }) => {
    const result = await browserCall('/eval', { script, pageId });
    return { content: [{ type: 'text', text: result.ok ? JSON.stringify(result.result, null, 2) : `Error: ${result.error}` }] };
  }
);

server.tool(
  'browser_pages',
  'List all open browser tabs.',
  {},
  async () => {
    const res = await fetch(`${BROWSER_PROXY}/pages`, {
      headers: { 'X-Api-Key': BROWSER_KEY },
    });
    const result = await res.json();
    const lines = result.pages.map(p => `${p.id}: ${p.url} — "${p.title}"`);
    return { content: [{ type: 'text', text: lines.length ? lines.join('\n') : 'No pages open' }] };
  }
);

server.tool(
  'browser_press',
  'Press a keyboard key (Enter, Tab, Escape, etc.).',
  {
    key: z.string().describe('Key to press (e.g. Enter, Tab, Escape, ArrowDown)'),
    pageId: z.string().optional().default('default'),
    selector: z.string().optional().describe('Focus element first'),
  },
  async ({ key, pageId, selector }) => {
    const result = await browserCall('/press', { key, pageId, selector });
    return { content: [{ type: 'text', text: result.ok ? `Pressed ${key}` : `Error: ${result.error}` }] };
  }
);

// ── Start ────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(err => {
  process.stderr.write(`MCP server failed: ${err.message}\n`);
  process.exit(1);
});

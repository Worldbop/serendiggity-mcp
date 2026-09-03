/**
 * Token Proxy Server
 *
 * Sits between the client-facing realtime page and OpenAI.
 * Clients authenticate with their company name — the proxy looks up
 * their workspace config and returns an ephemeral session token.
 * The actual API key never leaves the server.
 *
 * Usage:  node token-proxy.js
 * Port:   9801 (or COMMS_PROXY_PORT env var)
 */

import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROXY_PORT = parseInt(process.env.COMMS_PROXY_PORT || '9801', 10);

// ── Load OpenAI key from API .env ───────────────────────────────

function loadEnvKey(key) {
  try {
    const envPath = join(__dirname, '..', '..', 'api', '.env');
    const lines = readFileSync(envPath, 'utf8').split('\n');
    for (const line of lines) {
      const match = line.match(new RegExp(`^${key}=(.+)$`));
      if (match) return match[1].trim();
    }
  } catch { /* fall through */ }
  return process.env[key] || null;
}

// Use AGENT_STAFFING_OPENAI_KEY if set, else fall back to OPENAI_API_KEY
const OPENAI_API_KEY = loadEnvKey('AGENT_STAFFING_OPENAI_KEY') || loadEnvKey('OPENAI_API_KEY');
if (!OPENAI_API_KEY) {
  console.error('ERROR: No OpenAI API key found');
  process.exit(1);
}

// ── Customer workspaces ─────────────────────────────────────────
// In production this comes from a database. For now, simple map.

const workspaces = {
  sdge: {
    name: 'San Diego Gas & Electric',
    agents: [
      { id: 'aria',    name: 'Aria',    role: 'Executive Assistant',    voice: 'sage',    color: '#8b5cf6', emoji: '🌟' },
      { id: 'marcus',  name: 'Marcus',  role: 'Data Analyst',           voice: 'ash',     color: '#3b82f6', emoji: '📊' },
      { id: 'nova',    name: 'Nova',    role: 'Field Coordinator',      voice: 'shimmer', color: '#10b981', emoji: '⚡' },
      { id: 'rex',     name: 'Rex',     role: 'Grid Operations',        voice: 'verse',   color: '#f59e0b', emoji: '🔌' },
      { id: 'sierra',  name: 'Sierra',  role: 'Customer Relations',     voice: 'alloy',   color: '#ec4899', emoji: '💬' },
      { id: 'bolt',    name: 'Bolt',    role: 'Safety & Compliance',    voice: 'echo',    color: '#ef4444', emoji: '🛡️' },
      { id: 'sage',    name: 'Sage',    role: 'Engineering Support',    voice: 'coral',   color: '#06b6d4', emoji: '🔧' },
      { id: 'lumen',   name: 'Lumen',   role: 'Project Manager',        voice: 'ballad',  color: '#84cc16', emoji: '💡' },
    ],
    systemPrompt: `You are {agentName}, an AI agent working for San Diego Gas & Electric (SDG&E). You are part of their internal AI team. You are helpful, professional, and knowledgeable about energy utilities, grid operations, customer service, and general business operations. Keep responses conversational and concise — you are on a voice call. No filler phrases. Be warm but direct.`,
  },
  serendiggity: {
    name: 'Serendiggity',
    agents: [
      { id: 'mustafa',   name: 'Mustafa',   role: 'Lead AI',           voice: 'ash',     color: '#3b82f6', emoji: '🦅' },
      { id: 'senior',    name: 'Senior',     role: 'Backend Engineer',  voice: 'verse',   color: '#f59e0b', emoji: '🔧' },
      { id: 'junior',    name: 'Junior',     role: 'Frontend Engineer', voice: 'alloy',   color: '#10b981', emoji: '🎨' },
      { id: 'atlas',     name: 'Atlas',      role: 'Onboarding',        voice: 'shimmer', color: '#06b6d4', emoji: '🧭' },
      { id: 'nefertiti', name: 'Nefertiti',  role: 'Mobile Agent',      voice: 'coral',   color: '#ec4899', emoji: '👑' },
    ],
    systemPrompt: `You are {agentName}, an AI engineer on the Serendiggity team — a social boat rental and marketplace platform. You are sharp, resourceful, and direct. Keep responses conversational and concise — you are on a voice call. No filler.`,
  },
};

// ── Express app ─────────────────────────────────────────────────

const app = express();
app.use(cors());
app.use(express.json());

// ── Stripe ──────────────────────────────────────────────────────

const STRIPE_SECRET = loadEnvKey('STRIPE_API_KEY') || loadEnvKey('STRIPE_TEST_SECRET');
const stripe = STRIPE_SECRET ? new Stripe(STRIPE_SECRET) : null;
if (stripe) console.log('[stripe] Initialized');

// ── In-memory user store (prototype — replace with DB later) ────

const users = new Map();

// Serve client pages — landing.html as root
const clientDir = join(__dirname, '..', 'client');
app.use(express.static(clientDir));
app.get('/', (req, res) => res.sendFile(join(clientDir, 'landing.html')));

// ── Auth endpoints ──────────────────────────────────────────────

app.post('/api/auth/signup', async (req, res) => {
  const { email, password, company } = req.body;
  if (!email || !password || !company) return res.status(400).json({ error: 'Missing fields' });
  if (users.has(email)) return res.status(409).json({ error: 'Account already exists' });

  const workspace = company.toLowerCase().replace(/[^a-z0-9]/g, '');
  const user = {
    id: 'usr_' + Date.now().toString(36),
    email,
    company,
    workspace,
    agents: [],
    stripeCustomerId: null,
    createdAt: new Date().toISOString(),
  };

  // Create Stripe customer
  if (stripe) {
    try {
      const customer = await stripe.customers.create({ email, name: company });
      user.stripeCustomerId = customer.id;
    } catch (err) {
      console.log('[stripe] Customer creation failed:', err.message);
    }
  }

  users.set(email, user);
  console.log(`[auth] Signup: ${email} (${company})`);
  res.json(user);
});

app.post('/api/auth/login', (req, res) => {
  const { email } = req.body;
  const user = users.get(email);
  if (!user) return res.status(404).json({ error: 'Account not found' });
  console.log(`[auth] Login: ${email}`);
  res.json(user);
});

// ── Subscription endpoint ───────────────────────────────────────

app.post('/api/subscribe', async (req, res) => {
  const { userId, agents } = req.body;
  const user = [...users.values()].find(u => u.id === userId);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const amount = agents.length * 10000; // $100 per agent in cents
  const workspace = user.workspace;

  if (stripe && user.stripeCustomerId) {
    try {
      // Create a payment intent
      const pi = await stripe.paymentIntents.create({
        amount,
        currency: 'usd',
        customer: user.stripeCustomerId,
        metadata: {
          workspace,
          agentCount: agents.length.toString(),
          agentNames: agents.map(a => a.name).join(', '),
        },
        description: `Agent Comms - ${agents.length} agents for ${user.company}`,
      });

      // Save agents to user
      user.agents = agents;
      users.set(user.email, user);

      // Add workspace to dynamic workspaces
      workspaces[workspace] = {
        name: user.company,
        agents: agents.map((a, i) => ({
          id: a.name.toLowerCase().replace(/\s+/g, ''),
          name: a.name,
          role: a.role,
          voice: a.voice,
          color: a.color || ['#8b5cf6','#3b82f6','#10b981','#f59e0b','#ec4899','#ef4444','#06b6d4','#84cc16'][i % 8],
          emoji: a.avatar,
        })),
        systemPrompt: `You are {agentName}, an AI agent working for ${user.company}. You are helpful, professional, and knowledgeable. Keep responses conversational and concise — you are on a voice call. No filler phrases. Be warm but direct.`,
      };

      console.log(`[subscribe] ${user.company}: ${agents.length} agents, $${amount/100}/mo`);
      res.json({ clientSecret: pi.client_secret, workspace });
    } catch (err) {
      console.log('[stripe] Payment failed:', err.message);
      res.status(500).json({ error: err.message });
    }
  } else {
    // No Stripe — just save agents (prototype mode)
    user.agents = agents;
    users.set(user.email, user);
    workspaces[workspace] = {
      name: user.company,
      agents: agents.map((a, i) => ({
        id: a.name.toLowerCase().replace(/\s+/g, ''),
        name: a.name,
        role: a.role,
        voice: a.voice,
        color: a.color || ['#8b5cf6','#3b82f6','#10b981','#f59e0b','#ec4899','#ef4444','#06b6d4','#84cc16'][i % 8],
        emoji: a.avatar,
      })),
      systemPrompt: `You are {agentName}, an AI agent working for ${user.company}. Be helpful and conversational.`,
    };
    console.log(`[subscribe] ${user.company}: ${agents.length} agents (no Stripe)`);
    res.json({ workspace });
  }
});

// ── Admin endpoints ─────────────────────────────────────────────

app.get('/api/admin/customers', (req, res) => {
  const customers = [...users.values()].map(u => ({
    id: u.id,
    email: u.email,
    company: u.company,
    workspace: u.workspace,
    agentCount: u.agents.length,
    stripeCustomerId: u.stripeCustomerId,
    createdAt: u.createdAt,
  }));
  res.json(customers);
});

app.get('/api/admin/agents', (req, res) => {
  const allAgents = [];
  for (const [wsKey, ws] of Object.entries(workspaces)) {
    for (const agent of ws.agents) {
      allAgents.push({ ...agent, workspace: wsKey, customer: ws.name });
    }
  }
  res.json(allAgents);
});

app.get('/api/admin/stats', (req, res) => {
  const customerCount = users.size + 3; // +3 for demo data
  const totalAgents = Object.values(workspaces).reduce((sum, ws) => sum + ws.agents.length, 0);
  const mrr = totalAgents * 100;
  res.json({ customerCount, totalAgents, mrr, arr: mrr * 12, uptime: 99.7 });
});

// ── Agent Comms REST API (for cross-machine communication) ──────

import dbModule from './db.js';
const { getAgents: dbGetAgents, setAgentStatus: dbSetAgentStatus, ensureConversation, addMessage: dbAddMessage, getMessages: dbGetMessages, getRecentConversations } = await import('./db.js');
import { randomUUID } from 'crypto';

// POST /api/comms/send — send a message (cross-machine compatible)
app.post('/api/comms/send', (req, res) => {
  const { from, attendees, body } = req.body;
  if (!from || !attendees || !body) return res.status(400).json({ error: 'Missing from, attendees, or body' });

  const allAttendees = [...new Set([from, ...attendees])].sort();
  const key = allAttendees.join('|');
  ensureConversation(key, allAttendees);
  const id = randomUUID();
  dbAddMessage(key, id, from, body);

  console.log(`[comms] ${from} → [${allAttendees.join(', ')}]: ${body.substring(0, 80)}`);
  res.json({ id, key, sent: true });
});

// GET /api/comms/messages?attendees=senior,nefertiti&limit=25
app.get('/api/comms/messages', (req, res) => {
  const { attendees, limit } = req.query;
  if (!attendees) return res.status(400).json({ error: 'Missing attendees' });

  const sorted = attendees.split(',').map(s => s.trim()).sort();
  const key = sorted.join('|');
  const messages = dbGetMessages(key, parseInt(limit) || 25);
  res.json(messages);
});

// GET /api/comms/agents — list all agents with status
app.get('/api/comms/agents', (req, res) => {
  res.json(dbGetAgents());
});

// POST /api/comms/status — set agent status
app.post('/api/comms/status', (req, res) => {
  const { agentId, status } = req.body;
  if (!agentId || !status) return res.status(400).json({ error: 'Missing agentId or status' });
  dbSetAgentStatus(agentId, status);
  console.log(`[comms] ${agentId} status → ${status}`);
  res.json({ ok: true });
});

// GET /api/comms/conversations — list recent conversations
app.get('/api/comms/conversations', (req, res) => {
  res.json(getRecentConversations(parseInt(req.query.limit) || 20));
});

// GET /api/comms/dashboard — full status summary
app.get('/api/comms/dashboard', (req, res) => {
  const agents = dbGetAgents();
  const convs = getRecentConversations(10);
  res.json({ agents, conversations: convs, serverTime: new Date().toISOString() });
});

// ── Voice Chat (STT → LLM → TTS, like Serendeity) ──────────────

// In-memory conversation history per workspace+agent
const conversations = new Map();

// POST /api/voice/chat — send user text, get AI response + TTS audio
app.post('/api/voice/chat', async (req, res) => {
  const { workspace, agentId, text } = req.body;
  const ws = workspaces[workspace?.toLowerCase()];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const agent = ws.agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const prompt = ws.systemPrompt.replace('{agentName}', agent.name);
  const convKey = `${workspace}:${agentId}`;

  // Build conversation history
  if (!conversations.has(convKey)) {
    conversations.set(convKey, [{ role: 'system', content: prompt }]);
  }
  const history = conversations.get(convKey);
  history.push({ role: 'user', content: text });

  // Keep history manageable (last 20 messages + system)
  if (history.length > 21) {
    const sys = history[0];
    conversations.set(convKey, [sys, ...history.slice(-20)]);
  }

  try {
    // 1. Get AI response via OpenAI chat
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: history,
        max_tokens: 300,
      }),
    });

    if (!chatRes.ok) {
      const err = await chatRes.text();
      return res.status(chatRes.status).json({ error: err });
    }

    const chatData = await chatRes.json();
    const reply = chatData.choices[0].message.content;
    history.push({ role: 'assistant', content: reply });

    console.log(`[voice] ${agent.name}: "${text}" → "${reply.substring(0, 80)}..."`);

    // 2. Generate TTS audio
    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: agent.voice || 'sage',
        input: reply,
        response_format: 'mp3',
      }),
    });

    if (!ttsRes.ok) {
      // Return text without audio
      return res.json({ text: reply, audio: null });
    }

    const audioBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    res.json({ text: reply, audio: audioBase64, format: 'mp3' });
  } catch (err) {
    console.error('[voice] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/voice/greet — get initial greeting from agent
app.post('/api/voice/greet', async (req, res) => {
  const { workspace, agentId } = req.body;
  const ws = workspaces[workspace?.toLowerCase()];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const agent = ws.agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const prompt = ws.systemPrompt.replace('{agentName}', agent.name);
  const convKey = `${workspace}:${agentId}`;

  // Reset conversation
  conversations.set(convKey, [
    { role: 'system', content: prompt },
    { role: 'user', content: 'Hello! I just connected. Please greet me warmly and briefly introduce yourself.' },
  ]);

  try {
    const chatRes = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: conversations.get(convKey),
        max_tokens: 150,
      }),
    });

    const chatData = await chatRes.json();
    const reply = chatData.choices[0].message.content;
    conversations.get(convKey).push({ role: 'assistant', content: reply });

    // TTS
    const ttsRes = await fetch('https://api.openai.com/v1/audio/speech', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'tts-1',
        voice: agent.voice || 'sage',
        input: reply,
        response_format: 'mp3',
      }),
    });

    const audioBuffer = await ttsRes.arrayBuffer();
    const audioBase64 = Buffer.from(audioBuffer).toString('base64');

    console.log(`[voice] ${agent.name} greeting: "${reply.substring(0, 60)}..."`);
    res.json({ text: reply, audio: audioBase64, format: 'mp3' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/workspace/:name — lookup workspace + agents
app.get('/api/workspace/:name', (req, res) => {
  const ws = workspaces[req.params.name.toLowerCase()];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });
  res.json({ name: ws.name, agents: ws.agents });
});

// GET /api/workspace/:name — already defined above

// POST /api/token — create session + return ephemeral client_secret for WebRTC SDP
app.post('/api/token', async (req, res) => {
  const { workspace, agentId } = req.body;
  const ws = workspaces[workspace?.toLowerCase()];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const agent = ws.agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const model = 'gpt-4o-realtime-preview';
  const prompt = ws.systemPrompt.replace('{agentName}', agent.name);

  try {
    // GA Realtime API: create session with full config (voice, modalities, turn_detection)
    // This pre-configures the session so upstream audio is processed correctly.
    // The returned client_secret is used for the browser-side SDP exchange.
    const sessionRes = await fetch('https://api.openai.com/v1/realtime/sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        voice: agent.voice || 'sage',
        instructions: prompt,
        modalities: ['audio', 'text'],
        turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
      }),
    });
    if (!sessionRes.ok) {
      return res.status(sessionRes.status).json({ error: await sessionRes.text() });
    }
    const data = await sessionRes.json();
    const token = data.client_secret.value;
    console.log(`[token] Session created for ${agent.name}, expires ${data.client_secret.expires_at}`);
    res.json({ token, model, agent });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/call — proxy WebRTC SDP to OpenAI /v1/realtime/calls
// Browser sends SDP offer → proxy forwards with API key → returns SDP answer
app.post('/api/call', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { workspace, agentId } = req.query;
  const ws = workspaces[workspace?.toLowerCase()];
  if (!ws) return res.status(404).json({ error: 'Workspace not found' });

  const agent = ws.agents.find(a => a.id === agentId);
  if (!agent) return res.status(404).json({ error: 'Agent not found' });

  const sdpBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');
  const model = 'gpt-realtime-2';

  const prompt = ws.systemPrompt.replace('{agentName}', agent.name);
  console.log(`[call] ${agent.name} (${model}, voice=${agent.voice}) — SDP ${sdpBody.length} bytes`);

  try {
    const callUrl = `https://api.openai.com/v1/realtime/calls?model=${model}`;

    const callRes = await fetch(callUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${OPENAI_API_KEY}`,
          'Content-Type': 'application/sdp',
        },
        body: sdpBody,
      }
    );

    if (!callRes.ok) {
      const errText = await callRes.text();
      console.log(`[call] OpenAI error ${callRes.status}: ${errText.substring(0, 200)}`);
      return res.status(callRes.status).type('text/plain').send(errText);
    }

    const answer = await callRes.text();
    console.log(`[call] SDP answer received (${answer.length} bytes) for ${agent.name}`);
    res.type('application/sdp').send(answer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/realtime/sdp — strip datachannel from SDP and forward to OpenAI with ephemeral token
app.post('/api/realtime/sdp', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const { token, model } = req.query;
  if (!token) return res.status(400).json({ error: 'Missing token' });

  const sdpBody = req.body instanceof Buffer ? req.body.toString('utf8') : String(req.body || '');

  // Strip datachannel section — GA API rejects it
  let cleanSdp = sdpBody;
  const appIdx = cleanSdp.indexOf('\nm=application');
  if (appIdx !== -1) {
    const afterApp = cleanSdp.substring(appIdx + 1);
    const nextM = afterApp.indexOf('\nm=');
    cleanSdp = cleanSdp.substring(0, appIdx) + (nextM !== -1 ? afterApp.substring(nextM) : '') + '\n';
    cleanSdp = cleanSdp.replace(/a=group:BUNDLE\s+\d+\s+\d+/, 'a=group:BUNDLE 0');
    console.log(`[sdp] Stripped datachannel. ${sdpBody.length} -> ${cleanSdp.length} bytes`);
  }

  try {
    const sdpRes = await fetch(`https://api.openai.com/v1/realtime?model=${model || 'gpt-realtime-mini'}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/sdp',
      },
      body: cleanSdp,
    });

    if (!sdpRes.ok) {
      const errText = await sdpRes.text();
      console.log(`[sdp] OpenAI error ${sdpRes.status}: ${errText.substring(0, 200)}`);
      return res.status(sdpRes.status).type('text/plain').send(errText);
    }

    const answer = await sdpRes.text();
    console.log(`[sdp] SDP answer received (${answer.length} bytes)`);
    res.type('application/sdp').send(answer);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Stripe webhook (payment confirmations) ─────────────────────

app.post('/api/webhook/stripe', express.raw({ type: 'application/json' }), (req, res) => {
  const payload = req.body.toString();
  let event;
  try {
    event = JSON.parse(payload);
  } catch {
    return res.status(400).json({ error: 'Invalid payload' });
  }

  switch (event.type) {
    case 'payment_intent.succeeded':
      console.log(`[stripe] Payment succeeded: ${event.data.object.id} — $${event.data.object.amount / 100}`);
      break;
    case 'payment_intent.payment_failed':
      console.log(`[stripe] Payment failed: ${event.data.object.id}`);
      break;
    case 'customer.subscription.created':
      console.log(`[stripe] Subscription created: ${event.data.object.id}`);
      break;
    case 'customer.subscription.deleted':
      console.log(`[stripe] Subscription cancelled: ${event.data.object.id}`);
      break;
    default:
      console.log(`[stripe] Event: ${event.type}`);
  }

  res.json({ received: true });
});

app.listen(PROXY_PORT, () => {
  console.log(`[token-proxy] Running on http://localhost:${PROXY_PORT}`);
  console.log(`[token-proxy] Client page: http://localhost:${PROXY_PORT}/`);
  console.log(`[token-proxy] Workspaces: ${Object.keys(workspaces).join(', ')}`);
});

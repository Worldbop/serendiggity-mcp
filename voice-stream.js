/**
 * Streaming Voice Pipeline — Agent Staffing
 *
 * Full duplex voice: STT → LLM (streaming) → Cartesia WebSocket TTS (streaming)
 * Pre-seeded fillers mask latency. Context continuation for seamless speech.
 * Interruption detection cancels current speech and processes new input.
 *
 * Endpoints:
 *   WS  /voice/stream    — persistent WebSocket for real-time voice
 *   POST /voice/stream    — HTTP fallback (non-streaming, returns base64)
 */

import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'crypto';
import Cartesia from '@cartesia/cartesia-js';

// ── Config ──────────────────────────────────────────────────────

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const CARTESIA_API_KEY = process.env.CARTESIA_API_KEY;
const CARTESIA_VOICE_ID = process.env.CARTESIA_VOICE_ID;
const LLM_MODEL = process.env.LLM_MODEL || 'gpt-4o-mini';
const VOICE_WS_PORT = parseInt(process.env.VOICE_WS_PORT || '9802', 10);

// ── Cartesia Client ─────────────────────────────────────────────

let cartesia;
if (CARTESIA_API_KEY) {
  cartesia = new Cartesia({ apiKey: CARTESIA_API_KEY });
}

// ── Filler phrases (played instantly while LLM thinks) ──────────

const FILLERS = {
  ack: [
    "Got it.",
    "Sure thing.",
    "On it.",
    "Let me check.",
  ],
  thinking: [
    "One moment...",
    "Let me think about that.",
    "Good question...",
    "Working on it...",
  ],
};

function randomFiller(category = 'ack') {
  const list = FILLERS[category] || FILLERS.ack;
  return list[Math.floor(Math.random() * list.length)];
}

// ── LLM Streaming ───────────────────────────────────────────────

async function* streamLLM(messages, { model = LLM_MODEL, maxTokens = 300 } = {}) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`LLM error ${response.status}: ${await response.text()}`);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') return;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch {}
    }
  }
}

// ── Cartesia Streaming TTS ──────────────────────────────────────

class CartesiaStreamer {
  constructor(voiceId, onAudioChunk) {
    this.voiceId = voiceId;
    this.onAudioChunk = onAudioChunk;
    this.ws = null;
    this.textBuffer = '';
    this.flushTimer = null;
    this.cancelled = false;
  }

  async connect() {
    if (!cartesia) throw new Error('Cartesia not configured');
    // v3 SDK: websocket() returns a Promise
    this.ws = await cartesia.tts.websocket({
      container: 'raw',
      encoding: 'pcm_s16le',
      sampleRate: 24000,
    });
  }

  async sendText(text) {
    if (!this.ws || this.cancelled) return;

    this.textBuffer += text;

    // Flush when we hit sentence-ending punctuation or accumulate enough text
    if (/[.!?]\s*$/.test(this.textBuffer) || this.textBuffer.length > 80) {
      await this.flush();
    } else {
      // Debounce: flush after 200ms of no new tokens
      if (this.flushTimer) clearTimeout(this.flushTimer);
      this.flushTimer = setTimeout(() => this.flush(), 200);
    }
  }

  async flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.cancelled) return;

    const text = this.textBuffer.trim();
    if (!text) return;
    this.textBuffer = '';

    try {
      // v3 SDK: generate() returns an async iterable of audio chunks
      const response = this.ws.generate({
        model_id: 'sonic-2',
        voice: { mode: 'id', id: this.voiceId },
        transcript: text,
        output_format: { container: 'raw', encoding: 'pcm_s16le', sample_rate: 24000 },
      });

      for await (const chunk of response) {
        if (this.cancelled) break;
        if (chunk.data) {
          this.onAudioChunk(chunk.data);
        }
      }
    } catch (err) {
      if (!this.cancelled) {
        console.error('[cartesia] TTS error:', err.message);
      }
    }
  }

  cancel() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.textBuffer = '';
    this.cancelled = true;
    // Cancel any active context
    try { this.ws?.cancelContext?.('*'); } catch {}
  }

  reset() {
    this.cancelled = false;
    this.textBuffer = '';
  }

  async disconnect() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.cancelled = true;
    try { await this.ws?.close(); } catch {}
    this.ws = null;
  }
}

// ── Voice Session ───────────────────────────────────────────────

class VoiceSession {
  constructor(ws, agent, workspace) {
    this.ws = ws;
    this.agent = agent;
    this.workspace = workspace;
    this.history = [];
    this.cartesiaStreamer = null;
    this.speaking = false;
    this.cancelled = false;

    const systemPrompt = workspace.systemPrompt?.replace('{agentName}', agent.name)
      || `You are ${agent.name}, an AI assistant. Be helpful and conversational. Keep responses concise — you are on a voice call.`;

    this.history.push({ role: 'system', content: systemPrompt });
  }

  send(type, data) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...data }));
    }
  }

  async handleUserText(text) {
    if (!text?.trim()) return;

    // Interruption: if currently speaking, cancel and process new input
    if (this.speaking) {
      this.cancelled = true;
      this.cartesiaStreamer?.cancel();
      this.send('interrupted', {});
    }

    // Show user's words on their side
    this.send('transcript', { role: 'user', text, partial: false });
    this.history.push({ role: 'user', content: text });
    this.send('state', { state: 'thinking' });

    // Phase 1: Send filler immediately while LLM thinks (~200ms to voice)
    const filler = randomFiller('ack');
    this.speaking = true;
    this.cancelled = false;
    this.cartesiaStreamer?.reset();

    // Stream filler through Cartesia (non-blocking — audio chunks sent via callback)
    if (this.cartesiaStreamer) {
      this.cartesiaStreamer.sendText(filler + ' ').then(() => this.cartesiaStreamer.flush());
    }
    this.send('transcript', { role: 'agent', text: filler, partial: true });

    // Phase 2: Stream LLM response → pipe tokens to Cartesia TTS
    this.send('state', { state: 'speaking' });
    let fullResponse = '';

    try {
      for await (const token of streamLLM(this.history)) {
        if (this.cancelled) break;

        fullResponse += token;
        // Send word-by-word transcript so client shows words as they're spoken
        this.send('transcript', { role: 'agent', text: fullResponse, partial: true });

        // Pipe tokens to Cartesia for streaming TTS
        if (this.cartesiaStreamer) {
          await this.cartesiaStreamer.sendText(token);
        }
      }

      // Flush remaining text
      if (!this.cancelled && this.cartesiaStreamer) {
        await this.cartesiaStreamer.flush();
      }

      if (!this.cancelled) {
        this.history.push({ role: 'assistant', content: fullResponse });
        this.send('transcript', { role: 'agent', text: fullResponse, partial: false });
      }
    } catch (err) {
      console.error('[voice] LLM stream error:', err.message);
      this.send('error', { message: err.message });
    }

    this.speaking = false;
    this.send('state', { state: 'listening' });

    // Trim history to last 20 messages + system
    if (this.history.length > 21) {
      const sys = this.history[0];
      this.history = [sys, ...this.history.slice(-20)];
    }
  }

  async startGreeting() {
    this.send('state', { state: 'speaking' });
    const greeting = `Hi! I'm ${this.agent.name}. How can I help you today?`;

    this.send('transcript', { role: 'agent', text: greeting, partial: false });
    this.history.push({ role: 'assistant', content: greeting });

    if (this.cartesiaStreamer) {
      this.speaking = true;
      await this.cartesiaStreamer.sendText(greeting);
      await this.cartesiaStreamer.flush();
      this.speaking = false;
    }

    this.send('state', { state: 'listening' });
  }

  async init() {
    if (CARTESIA_API_KEY && this.agent.voice) {
      try {
        this.cartesiaStreamer = new CartesiaStreamer(
          CARTESIA_VOICE_ID || this.agent.voiceId || this.agent.voice,
          (audioData) => {
            this.send('audio', { data: audioData, format: 'pcm_s16le', sampleRate: 24000 });
          }
        );
        await this.cartesiaStreamer.connect();
      } catch (err) {
        console.error('[voice] Cartesia connect failed:', err.message);
        this.cartesiaStreamer = null;
      }
    }
  }

  async cleanup() {
    await this.cartesiaStreamer?.disconnect();
  }
}

// ── WebSocket Server ────────────────────────────────────────────

const sessions = new Map();

// Workspaces (same as token-proxy.js — will be unified later)
const workspaces = {
  serendiggity: {
    name: 'Serendiggity',
    agents: [
      { id: 'mustafa', name: 'Mustafa', role: 'Lead AI', voice: 'ash', color: '#3b82f6' },
      { id: 'senior', name: 'Senior', role: 'Backend Engineer', voice: 'verse', color: '#f59e0b' },
      { id: 'junior', name: 'Junior', role: 'Frontend Engineer', voice: 'alloy', color: '#10b981' },
    ],
    systemPrompt: `You are {agentName}, an AI engineer on the Serendiggity team. You are sharp, resourceful, and direct. Keep responses conversational and concise — you are on a voice call. No filler.`,
  },
};

export function startVoiceServer(port = VOICE_WS_PORT, externalWorkspaces = null) {
  const wss = new WebSocketServer({ port, host: '0.0.0.0' });
  const ws_map = externalWorkspaces || workspaces;

  console.log(`[voice-stream] WebSocket server on ws://0.0.0.0:${port}`);

  wss.on('connection', (ws) => {
    const sessionId = randomUUID();
    console.log(`[voice-stream] Client connected: ${sessionId}`);

    ws.on('message', async (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        switch (msg.type) {
          case 'start_call': {
            const { workspace: wsName, agentId } = msg;
            const wsDef = ws_map[wsName?.toLowerCase()];
            if (!wsDef) { ws.send(JSON.stringify({ type: 'error', message: 'Workspace not found' })); return; }
            const agent = wsDef.agents.find(a => a.id === agentId);
            if (!agent) { ws.send(JSON.stringify({ type: 'error', message: 'Agent not found' })); return; }

            const session = new VoiceSession(ws, agent, wsDef);
            await session.init();
            sessions.set(sessionId, session);

            ws.send(JSON.stringify({ type: 'call_started', sessionId, agent }));
            await session.startGreeting();
            break;
          }

          case 'user_text': {
            const session = sessions.get(sessionId);
            if (!session) { ws.send(JSON.stringify({ type: 'error', message: 'No active call' })); return; }
            await session.handleUserText(msg.text);
            break;
          }

          case 'interrupt': {
            const session = sessions.get(sessionId);
            if (session) {
              session.cancelled = true;
              await session.cartesiaStreamer?.cancel();
              ws.send(JSON.stringify({ type: 'interrupted' }));
            }
            break;
          }

          case 'end_call': {
            const session = sessions.get(sessionId);
            if (session) {
              await session.cleanup();
              sessions.delete(sessionId);
            }
            ws.send(JSON.stringify({ type: 'call_ended' }));
            break;
          }
        }
      } catch (err) {
        console.error('[voice-stream] Error:', err.message);
        ws.send(JSON.stringify({ type: 'error', message: err.message }));
      }
    });

    ws.on('close', async () => {
      const session = sessions.get(sessionId);
      if (session) {
        await session.cleanup();
        sessions.delete(sessionId);
      }
      console.log(`[voice-stream] Client disconnected: ${sessionId}`);
    });
  });

  return wss;
}

// ── Standalone mode ─────────────────────────────────────────────

if (process.argv[1]?.endsWith('voice-stream.js')) {
  if (!OPENAI_API_KEY) { console.error('OPENAI_API_KEY required'); process.exit(1); }
  startVoiceServer();
}

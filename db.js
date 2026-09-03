import Database from 'better-sqlite3';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(join(DATA_DIR, 'comms.db'));

// WAL mode for concurrent reads
db.pragma('journal_mode = WAL');

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS agents (
    id        TEXT PRIMARY KEY,
    name      TEXT NOT NULL,
    role      TEXT NOT NULL,
    color     TEXT NOT NULL DEFAULT '#3b82f6',
    voice     TEXT NOT NULL DEFAULT 'alloy',
    voice_id  TEXT,
    avatar    TEXT,
    status    TEXT NOT NULL DEFAULT 'offline',
    last_seen TEXT
  );

  CREATE TABLE IF NOT EXISTS conversations (
    key         TEXT PRIMARY KEY,
    attendees   TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    last_active TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS messages (
    id              TEXT PRIMARY KEY,
    conversation_key TEXT NOT NULL,
    from_agent      TEXT NOT NULL,
    body            TEXT NOT NULL,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_key) REFERENCES conversations(key)
  );

  CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_key, created_at);
`);

// Migrate: add voice_id and avatar columns if missing (for existing databases)
const agentCols = db.pragma('table_info(agents)').map(c => c.name);
if (!agentCols.includes('voice_id')) {
  db.exec('ALTER TABLE agents ADD COLUMN voice_id TEXT');
}
if (!agentCols.includes('avatar')) {
  db.exec('ALTER TABLE agents ADD COLUMN avatar TEXT');
}

// Seed default agents if empty
const agentCount = db.prepare('SELECT COUNT(*) as c FROM agents').get();
if (agentCount.c === 0) {
  const insert = db.prepare(
    'INSERT INTO agents (id, name, role, color, voice, avatar) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const agents = [
    ['michael',   'Michael',   'Product Owner',     '#8b5cf6', 'echo',    null],
    ['mustafa',   'Mustafa',   'Lead AI',           '#3b82f6', 'onyx',    'eagle'],
    ['senior',    'Senior',    'Backend Engineer',  '#f59e0b', 'fable',   null],
    ['junior',    'Junior',    'Frontend Engineer', '#10b981', 'alloy',   null],
    ['atlas',     'Atlas',     'Onboarding',        '#06b6d4', 'shimmer', null],
    ['nefertiti', 'Nefertiti', 'Mobile Agent',      '#ec4899', 'nova',    null],
  ];

  const tx = db.transaction(() => {
    for (const a of agents) insert.run(...a);
  });
  tx();
}

// Seed default config
const configCount = db.prepare('SELECT COUNT(*) as c FROM config').get();
if (configCount.c === 0) {
  const insert = db.prepare('INSERT INTO config (key, value) VALUES (?, ?)');
  const tx = db.transaction(() => {
    insert.run('agent_id', 'senior');
    insert.run('gateway_url', 'ws://localhost:18789');
    insert.run('api_base_url', 'http://localhost:3000/api');
    insert.run('agent_comms_key', '');
    insert.run('openai_api_key', '');
    insert.run('stt_provider', 'openai');
    insert.run('tts_provider', 'openai');
  });
  tx();
}

export default db;

// ── Query helpers ───────────────────────────────────────────────

export function getConfig(key) {
  const row = db.prepare('SELECT value FROM config WHERE key = ?').get(key);
  return row?.value ?? null;
}

export function setConfig(key, value) {
  db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, value);
}

export function getAllConfig() {
  return db.prepare('SELECT key, value FROM config').all();
}

export function getAgents() {
  return db.prepare('SELECT * FROM agents ORDER BY name').all();
}

export function setAgentStatus(id, status) {
  db.prepare(
    "UPDATE agents SET status = ?, last_seen = datetime('now') WHERE id = ?"
  ).run(status, id);
}

export function getConversation(key) {
  return db.prepare('SELECT * FROM conversations WHERE key = ?').get(key);
}

export function ensureConversation(key, attendees) {
  const existing = getConversation(key);
  if (!existing) {
    db.prepare(
      'INSERT INTO conversations (key, attendees) VALUES (?, ?)'
    ).run(key, JSON.stringify(attendees));
  }
  return getConversation(key);
}

export function addMessage(convKey, id, fromAgent, body) {
  db.prepare(
    'INSERT INTO messages (id, conversation_key, from_agent, body) VALUES (?, ?, ?, ?)'
  ).run(id, convKey, fromAgent, body);
  db.prepare(
    "UPDATE conversations SET last_active = datetime('now') WHERE key = ?"
  ).run(convKey);
}

export function getMessages(convKey, limit = 50) {
  return db.prepare(
    'SELECT * FROM messages WHERE conversation_key = ? ORDER BY created_at DESC LIMIT ?'
  ).all(convKey, limit).reverse();
}

export function getRecentConversations(limit = 20) {
  return db.prepare(
    'SELECT * FROM conversations ORDER BY last_active DESC LIMIT ?'
  ).all(limit);
}

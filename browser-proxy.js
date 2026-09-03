import express from 'express';
import { chromium } from 'playwright';

const app = express();
app.use(express.json({ limit: '10mb' }));

const PORT = process.env.PORT || 3500;
const API_KEY = process.env.BROWSER_API_KEY || 'nefertiti-browser-2026';

let browser = null;
let context = null;
const pages = new Map(); // pageId -> page

// Auth middleware
function auth(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.key;
  if (key !== API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  next();
}

app.use(auth);

// Ensure browser is running
async function ensureBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await chromium.launch({ headless: false });
    context = await browser.newContext({
      viewport: { width: 1280, height: 900 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
  }
  return context;
}

// Get or create a page
async function getPage(pageId = 'default') {
  if (!pages.has(pageId)) {
    const ctx = await ensureBrowser();
    const page = await ctx.newPage();
    pages.set(pageId, page);
  }
  return pages.get(pageId);
}

// ── Navigate ──────────────────────────────────────────────
app.post('/navigate', async (req, res) => {
  try {
    const { url, pageId = 'default', waitFor = 'load' } = req.body;
    const page = await getPage(pageId);
    await page.goto(url, { waitUntil: waitFor, timeout: 30000 });
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Screenshot ────────────────────────────────────────────
app.post('/screenshot', async (req, res) => {
  try {
    const { pageId = 'default', fullPage = false } = req.body;
    const page = await getPage(pageId);
    const buffer = await page.screenshot({ fullPage, type: 'png' });
    res.json({
      ok: true,
      title: await page.title(),
      url: page.url(),
      image: buffer.toString('base64')
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Get page text content ─────────────────────────────────
app.post('/content', async (req, res) => {
  try {
    const { pageId = 'default', selector = 'body' } = req.body;
    const page = await getPage(pageId);
    const text = await page.locator(selector).innerText({ timeout: 5000 });
    res.json({ ok: true, text: text.slice(0, 50000), url: page.url(), title: await page.title() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Get page HTML ─────────────────────────────────────────
app.post('/html', async (req, res) => {
  try {
    const { pageId = 'default', selector = 'body' } = req.body;
    const page = await getPage(pageId);
    const html = await page.locator(selector).innerHTML({ timeout: 5000 });
    res.json({ ok: true, html: html.slice(0, 100000), url: page.url() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Click ─────────────────────────────────────────────────
app.post('/click', async (req, res) => {
  try {
    const { selector, pageId = 'default', text } = req.body;
    const page = await getPage(pageId);
    if (text) {
      await page.getByText(text).first().click({ timeout: 5000 });
    } else {
      await page.locator(selector).click({ timeout: 5000 });
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    res.json({ ok: true, url: page.url(), title: await page.title() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Type / Fill ───────────────────────────────────────────
app.post('/type', async (req, res) => {
  try {
    const { selector, text, pageId = 'default', clear = true } = req.body;
    const page = await getPage(pageId);
    if (clear) {
      await page.locator(selector).fill(text, { timeout: 5000 });
    } else {
      await page.locator(selector).type(text, { timeout: 5000 });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Press key ─────────────────────────────────────────────
app.post('/press', async (req, res) => {
  try {
    const { key, pageId = 'default', selector } = req.body;
    const page = await getPage(pageId);
    if (selector) {
      await page.locator(selector).press(key, { timeout: 5000 });
    } else {
      await page.keyboard.press(key);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Wait for selector ─────────────────────────────────────
app.post('/wait', async (req, res) => {
  try {
    const { selector, pageId = 'default', timeout = 10000, state = 'visible' } = req.body;
    const page = await getPage(pageId);
    await page.locator(selector).waitFor({ state, timeout });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Evaluate JS ───────────────────────────────────────────
app.post('/eval', async (req, res) => {
  try {
    const { script, pageId = 'default' } = req.body;
    const page = await getPage(pageId);
    const result = await page.evaluate(script);
    res.json({ ok: true, result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── List open pages ───────────────────────────────────────
app.get('/pages', async (req, res) => {
  const list = [];
  for (const [id, page] of pages) {
    try {
      list.push({ id, url: page.url(), title: await page.title() });
    } catch {
      list.push({ id, url: 'closed', title: 'closed' });
    }
  }
  res.json({ pages: list });
});

// ── Close a page ──────────────────────────────────────────
app.post('/close', async (req, res) => {
  try {
    const { pageId = 'default' } = req.body;
    const page = pages.get(pageId);
    if (page) {
      await page.close();
      pages.delete(pageId);
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Health ────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    browser: browser?.isConnected() ? 'connected' : 'disconnected',
    pages: pages.size
  });
});

// Start
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Nefertiti Browser Proxy running on http://0.0.0.0:${PORT}`);
  console.log(`API Key: ${API_KEY}`);
  console.log('Endpoints: /navigate, /screenshot, /content, /html, /click, /type, /press, /wait, /eval, /pages, /close, /health');
});

// Cleanup on exit
process.on('SIGINT', async () => {
  if (browser) await browser.close();
  process.exit();
});

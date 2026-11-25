'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT) || 8080;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ASK_MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const DATABASE_URL = process.env.DATABASE_URL || '';

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL }) : null;

if (pool) {
  // An idle client erroring (e.g. the database restarting) must not crash the server.
  pool.on('error', (err) => console.error('[db] idle client error:', err.message));
}

const SCHEMA_SQL = `
  CREATE EXTENSION IF NOT EXISTS pgcrypto;

  CREATE TABLE IF NOT EXISTS canvases (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    title text NOT NULL DEFAULT 'Untitled canvas',
    created_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE TABLE IF NOT EXISTS nodes (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canvas_id uuid NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    parent_id uuid NULL REFERENCES nodes(id) ON DELETE CASCADE,
    prompt text NOT NULL,
    reply text NULL,
    status text NOT NULL DEFAULT 'pending',
    error text NULL,
    model text NULL,
    x real NOT NULL DEFAULT 0,
    y real NOT NULL DEFAULT 0,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS nodes_canvas_id_idx ON nodes(canvas_id);
  CREATE INDEX IF NOT EXISTS nodes_parent_id_idx ON nodes(parent_id);
`;

let schemaReady = false;

// Create the schema on start. If the database is not reachable yet, keep
// retrying in the background so the server still comes up and /api/health
// can report db: false instead of the whole service crash-looping.
async function ensureSchema(attempt = 1) {
  if (!pool) {
    console.warn('[db] DATABASE_URL is not set; running without a database.');
    return;
  }
  try {
    await pool.query(SCHEMA_SQL);
    schemaReady = true;
    console.log('[db] schema ready (canvases, nodes).');
  } catch (err) {
    const delayMs = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
    console.error(`[db] schema creation failed (attempt ${attempt}): ${err.message}. Retrying in ${delayMs / 1000}s.`);
    setTimeout(() => ensureSchema(attempt + 1), delayMs).unref();
  }
}

async function dbIsUp() {
  if (!pool) return false;
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

// Health stays open (registered before the auth middleware).
app.get('/api/health', async (req, res) => {
  res.json({ ok: true, db: await dbIsUp(), model: ASK_MODEL });
});

// HTTP Basic Auth on everything else when APP_PASSWORD is set.
// Any username is accepted; the password must equal APP_PASSWORD.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function basicAuth(req, res, next) {
  if (!APP_PASSWORD) return next();

  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme && scheme.toLowerCase() === 'basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const sep = decoded.indexOf(':');
    const password = sep === -1 ? '' : decoded.slice(sep + 1);
    if (safeEqual(password, APP_PASSWORD)) return next();
  }

  res.set('WWW-Authenticate', 'Basic realm="canvas-chat-tree", charset="UTF-8"');
  res.status(401).send('Authentication required.');
}

app.use(basicAuth);

app.use(express.static(path.join(__dirname, 'public')));

// Unknown API routes get JSON, not the HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] canvas-chat-tree listening on port ${PORT}`);
  console.log(`[server] basic auth: ${APP_PASSWORD ? 'on' : 'OFF (APP_PASSWORD not set)'}; model: ${ASK_MODEL}`);
  ensureSchema();
});

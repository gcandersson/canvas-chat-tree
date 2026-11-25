'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const { Pool } = require('pg');
const { Anthropic } = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT) || 8080;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ASK_MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const DATABASE_URL = process.env.DATABASE_URL || '';

const MAX_TOKENS = 2048;
const MAX_PROMPT_CHARS = 20000;
const SYSTEM_PROMPT =
  'The user is exploring ideas on a branching canvas, where each exchange is a node and any node ' +
  'can be branched in a new direction. You see only the path of exchanges leading to the current ' +
  'prompt. Answer the latest prompt clearly and concisely, in plain text.';

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

    // AI calls run in this process, so any node still pending at start was
    // orphaned by a restart or deploy. Mark it as an error so it can be retried
    // instead of spinning forever.
    const orphaned = await pool.query(
      `UPDATE nodes
          SET status = 'error',
              error = 'The server restarted before the AI replied. Retry to ask again.',
              updated_at = now()
        WHERE status = 'pending'`
    );
    if (orphaned.rowCount > 0) {
      console.warn(`[db] marked ${orphaned.rowCount} orphaned pending node(s) as error.`);
    }

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
// AI: path assembly and the background call
// ---------------------------------------------------------------------------

let anthropic = null;
function getAnthropic() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set on the server.');
  }
  if (!anthropic) {
    // Reads ANTHROPIC_API_KEY from the environment. Timeout is in milliseconds.
    anthropic = new Anthropic({ timeout: 120 * 1000 });
  }
  return anthropic;
}

// The path: walk parent_id from the node up to its root, returned root first.
// Sibling branches are never touched, because the walk only follows parent_id.
async function loadPath(nodeId) {
  const { rows } = await pool.query(
    `WITH RECURSIVE path AS (
       SELECT id, parent_id, prompt, reply, 0 AS depth
         FROM nodes
        WHERE id = $1
       UNION ALL
       SELECT n.id, n.parent_id, n.prompt, n.reply, p.depth + 1
         FROM nodes n
         JOIN path p ON n.id = p.parent_id
     )
     SELECT id, prompt, reply FROM path ORDER BY depth DESC`,
    [nodeId]
  );
  return rows;
}

// Turn a path (root first, target node last) into alternating messages:
// each ancestor contributes its prompt and its reply; the target node
// contributes only its prompt, as the final user message.
function pathToMessages(pathRows) {
  const messages = [];
  const last = pathRows.length - 1;
  pathRows.forEach((row, i) => {
    messages.push({ role: 'user', content: row.prompt });
    if (i < last) {
      if (!row.reply) {
        throw new Error('A node earlier in this path has no reply yet, so this node cannot be answered.');
      }
      messages.push({ role: 'assistant', content: row.reply });
    }
  });
  return messages;
}

function describeAiError(err) {
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return 'The AI request timed out.';
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return `Could not reach the AI service: ${err.message}`;
  }
  if (err instanceof Anthropic.APIError) {
    // Prefer the API's own message over the SDK's "404 {json}" string.
    const detail = (err.error && err.error.error && err.error.error.message) || err.message;
    return `AI request failed (${err.status}): ${detail}`;
  }
  return err && err.message ? err.message : String(err);
}

// Answer one pending node. Never throws: the outcome is written to the row.
async function answerNode(nodeId) {
  try {
    const pathRows = await loadPath(nodeId);
    if (pathRows.length === 0) return; // node was deleted meanwhile
    const messages = pathToMessages(pathRows);

    const response = await getAnthropic().messages.create({
      model: ASK_MODEL,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages,
    });

    let reply = response.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    if (response.stop_reason === 'refusal') {
      throw new Error('The AI declined to answer this prompt.');
    }
    if (!reply) {
      throw new Error(
        response.stop_reason === 'max_tokens'
          ? 'The AI ran out of output tokens before writing a reply.'
          : 'The AI returned an empty reply.'
      );
    }
    if (response.stop_reason === 'max_tokens') {
      reply += '\n\n[Reply cut off at the length limit.]';
    }

    await pool.query(
      `UPDATE nodes
          SET status = 'done', reply = $2, model = $3, error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending'`,
      [nodeId, reply, response.model || ASK_MODEL]
    );
  } catch (err) {
    const message = describeAiError(err);
    console.error(`[ai] node ${nodeId} failed: ${message}`);
    try {
      await pool.query(
        `UPDATE nodes
            SET status = 'error', error = $2, updated_at = now()
          WHERE id = $1 AND status = 'pending'`,
        [nodeId, message]
      );
    } catch (dbErr) {
      console.error(`[ai] could not record the error for node ${nodeId}: ${dbErr.message}`);
    }
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

// --- API helpers -----------------------------------------------------------

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function requireUuid(value, label) {
  if (typeof value !== 'string' || !UUID_RE.test(value)) {
    throw new HttpError(400, `${label} must be a UUID.`);
  }
  return value;
}

// x and y are optional on create (default 0) but must be finite numbers when given.
function readCoord(value, label, { required }) {
  if (value === undefined || value === null) {
    if (required) throw new HttpError(400, `${label} is required and must be a number.`);
    return 0;
  }
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new HttpError(400, `${label} must be a number.`);
  }
  return value;
}

// Everything under /api below here needs the database.
app.use('/api', (req, res, next) => {
  if (!pool || !schemaReady) {
    return next(new HttpError(503, 'The database is not ready yet. Try again in a moment.'));
  }
  next();
});

// --- Canvases --------------------------------------------------------------

app.get('/api/canvases', async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.title, c.created_at, count(n.id)::int AS node_count
       FROM canvases c
       LEFT JOIN nodes n ON n.canvas_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC`
  );
  res.json(rows);
});

app.post('/api/canvases', async (req, res) => {
  const body = req.body || {};
  let title = null;
  if (body.title !== undefined && body.title !== null) {
    if (typeof body.title !== 'string') throw new HttpError(400, 'title must be a string.');
    title = body.title.trim().slice(0, 200) || null;
  }
  const { rows } = await pool.query(
    `INSERT INTO canvases (title) VALUES (COALESCE($1, 'Untitled canvas'))
     RETURNING id, title, created_at`,
    [title]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/canvases/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Canvas id');
  const canvas = await pool.query('SELECT id, title, created_at FROM canvases WHERE id = $1', [id]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');
  const nodes = await pool.query(
    'SELECT * FROM nodes WHERE canvas_id = $1 ORDER BY created_at ASC, id ASC',
    [id]
  );
  res.json({ canvas: canvas.rows[0], nodes: nodes.rows });
});

// --- Nodes -----------------------------------------------------------------

app.post('/api/canvases/:id/nodes', async (req, res) => {
  const canvasId = requireUuid(req.params.id, 'Canvas id');
  const body = req.body || {};

  if (typeof body.prompt !== 'string' || !body.prompt.trim()) {
    throw new HttpError(400, 'prompt is required and must be a non-empty string.');
  }
  const prompt = body.prompt.trim();
  if (prompt.length > MAX_PROMPT_CHARS) {
    throw new HttpError(400, `prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);
  }
  const x = readCoord(body.x, 'x', { required: false });
  const y = readCoord(body.y, 'y', { required: false });

  const parentId =
    body.parent_id === undefined || body.parent_id === null
      ? null
      : requireUuid(body.parent_id, 'parent_id');

  const canvas = await pool.query('SELECT id FROM canvases WHERE id = $1', [canvasId]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');

  if (parentId) {
    const parent = await pool.query('SELECT canvas_id, status FROM nodes WHERE id = $1', [parentId]);
    if (parent.rowCount === 0 || parent.rows[0].canvas_id !== canvasId) {
      throw new HttpError(400, 'parent_id does not refer to a node on this canvas.');
    }
    if (parent.rows[0].status !== 'done') {
      throw new HttpError(409, `The parent node has no reply yet (status: ${parent.rows[0].status}).`);
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO nodes (canvas_id, parent_id, prompt, x, y)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [canvasId, parentId, prompt, x, y]
  );

  // Return the pending node immediately; the AI call runs in the background.
  res.status(201).json(rows[0]);
  answerNode(rows[0].id);
});

app.get('/api/nodes/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Node id');
  const { rows } = await pool.query('SELECT * FROM nodes WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'Node not found.');
  res.json(rows[0]);
});

app.patch('/api/nodes/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Node id');
  const body = req.body || {};
  const x = readCoord(body.x, 'x', { required: true });
  const y = readCoord(body.y, 'y', { required: true });
  const { rows } = await pool.query(
    'UPDATE nodes SET x = $2, y = $3, updated_at = now() WHERE id = $1 RETURNING *',
    [id, x, y]
  );
  if (rows.length === 0) throw new HttpError(404, 'Node not found.');
  res.json(rows[0]);
});

app.post('/api/nodes/:id/retry', async (req, res) => {
  const id = requireUuid(req.params.id, 'Node id');
  // Only an error node can be retried. The status check is in the UPDATE itself,
  // so two simultaneous retries cannot both start an AI call.
  const { rows } = await pool.query(
    `UPDATE nodes
        SET status = 'pending', error = NULL, updated_at = now()
      WHERE id = $1 AND status = 'error'
      RETURNING *`,
    [id]
  );
  if (rows.length === 0) {
    const existing = await pool.query('SELECT status FROM nodes WHERE id = $1', [id]);
    if (existing.rowCount === 0) throw new HttpError(404, 'Node not found.');
    throw new HttpError(409, `Only an error node can be retried (status: ${existing.rows[0].status}).`);
  }
  res.json(rows[0]);
  answerNode(id);
});

// --- Fallbacks -------------------------------------------------------------

// Unknown API routes get JSON, not the HTML page.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Errors: always JSON for the API, with a message the frontend can show.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  let status = err.status || err.statusCode || 500;
  let message = err.message || 'Something went wrong.';
  if (err.type === 'entity.parse.failed') {
    status = 400;
    message = 'The request body is not valid JSON.';
  }
  if (status >= 500 && status !== 503) {
    console.error(`[server] ${req.method} ${req.originalUrl} failed:`, err);
    message = 'Server error. Try again.';
  }
  res.status(status).json({ error: message });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

app.listen(PORT, () => {
  console.log(`[server] canvas-chat-tree listening on port ${PORT}`);
  console.log(`[server] basic auth: ${APP_PASSWORD ? 'on' : 'OFF (APP_PASSWORD not set)'}; model: ${ASK_MODEL}`);
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[server] ANTHROPIC_API_KEY is not set; nodes will fail with an error until it is.');
  }
  ensureSchema();
});

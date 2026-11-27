'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const express = require('express');
const multer = require('multer');
const mammoth = require('mammoth');
const { Pool } = require('pg');
const { Anthropic } = require('@anthropic-ai/sdk');

const PORT = Number(process.env.PORT) || 8080;
const APP_PASSWORD = process.env.APP_PASSWORD || '';
const ASK_MODEL = process.env.ASK_MODEL || 'claude-sonnet-5-5';
const DATABASE_URL = process.env.DATABASE_URL || '';

const MAX_TOKENS = 8192;
const MAX_PROMPT_CHARS = 20000;
const MAX_STICKY_CHARS = 10000;
const MAX_BATCH_POSITIONS = 5000;
const MAX_INSTRUCTIONS_CHARS = 20000;
const PINNED_NOTES_CAP = 8000; // total characters of pinned-note text sent to the AI
const STICKY_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'];
const MAX_FILE_BYTES = 10 * 1024 * 1024; // hard limit per uploaded file
const MAX_FILE_NAME_CHARS = 200;
const MAX_FILE_TEXT_RESPONSE = 200000;   // most characters of extracted text sent to the page at once
const CONTEXT_MODES = ['off', 'branch', 'canvas'];
// Accepted uploads, by file extension. The stored MIME type always comes from
// this table, never from what the browser claims. kind decides how the bytes
// are checked and whether text is extracted.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const FILE_TYPES = {
  pdf: { mime: 'application/pdf', kind: 'pdf' },
  png: { mime: 'image/png', kind: 'image' },
  jpg: { mime: 'image/jpeg', kind: 'image' },
  jpeg: { mime: 'image/jpeg', kind: 'image' },
  webp: { mime: 'image/webp', kind: 'image' },
  gif: { mime: 'image/gif', kind: 'image' },
  txt: { mime: 'text/plain', kind: 'text' },
  md: { mime: 'text/markdown', kind: 'text' },
  csv: { mime: 'text/csv', kind: 'text' },
  docx: { mime: DOCX_MIME, kind: 'word' },
};
const ACCEPTED_LABEL = 'PDF, PNG, JPG, WEBP, GIF, TXT, MD, CSV and DOCX';
// Only these are ever shown inline by the browser; everything else downloads.
const INLINE_MIMES = new Set(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const SYSTEM_PROMPT =
  'The user is exploring ideas on a branching canvas, where each exchange is a node and any node ' +
  'can be branched in a new direction. You see only the path of exchanges leading to the current ' +
  'prompt. Answer the latest prompt clearly and concisely. You may use simple Markdown (bold, ' +
  'headings, lists, code) where it helps; do not use tables or images.';

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

  -- Sticky notes. node_id null = free-floating: x and y are canvas coordinates.
  -- node_id set = attached: x and y are the offset from that node's top-left
  -- corner, so the sticky follows its card without any extra saves.
  CREATE TABLE IF NOT EXISTS stickies (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canvas_id uuid NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    node_id uuid NULL REFERENCES nodes(id) ON DELETE SET NULL,
    x real NOT NULL DEFAULT 0,
    y real NOT NULL DEFAULT 0,
    color text NOT NULL DEFAULT 'yellow',
    content text NOT NULL DEFAULT '',
    in_context boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS stickies_canvas_id_idx ON stickies(canvas_id);
  CREATE INDEX IF NOT EXISTS stickies_node_id_idx ON stickies(node_id);

  -- Canvas instructions: free text sent to the AI for every node on the canvas.
  ALTER TABLE canvases ADD COLUMN IF NOT EXISTS instructions text NULL;

  -- Uploaded files, shown as file bubbles. The bytes live in data. Position
  -- works like stickies: node_id null = canvas coordinates, node_id set =
  -- offset from that node's top-left corner. text_content holds the text of
  -- txt, md, csv and docx files; it is null for PDFs and images.
  CREATE TABLE IF NOT EXISTS files (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    canvas_id uuid NOT NULL REFERENCES canvases(id) ON DELETE CASCADE,
    name text NOT NULL,
    mime text NOT NULL,
    size int NOT NULL,
    data bytea NOT NULL,
    text_content text NULL,
    status text NOT NULL DEFAULT 'ready',
    error text NULL,
    x real NOT NULL DEFAULT 0,
    y real NOT NULL DEFAULT 0,
    node_id uuid NULL REFERENCES nodes(id) ON DELETE SET NULL,
    context_mode text NOT NULL DEFAULT 'off',
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
  );

  CREATE INDEX IF NOT EXISTS files_canvas_id_idx ON files(canvas_id);
  CREATE INDEX IF NOT EXISTS files_node_id_idx ON files(node_id);
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
    console.log('[db] schema ready (canvases, nodes, stickies, files).');
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
    // Errors that arrive in the middle of a stream carry no HTTP status.
    return err.status ? `AI request failed (${err.status}): ${detail}` : `AI request failed: ${detail}`;
  }
  return err && err.message ? err.message : String(err);
}

// --- Canvas context --------------------------------------------------------
// Besides the path, every AI call on a canvas gets that canvas's instructions
// and its pinned notes (stickies marked "Use as AI context"). Stickies that
// are not pinned are never sent.

// Which pinned notes are sent. Notes come newest first; a note is included
// while it still fits in the cap, otherwise it is left out. Empty notes are
// skipped. The page applies the same rule (selectPinnedNotes in
// public/index.html) to show which notes were left out.
function selectPinnedNotes(notes) {
  const included = [];
  const leftOut = [];
  let used = 0;
  for (const note of notes) {
    const text = (note.content || '').trim();
    if (!text) continue;
    if (used + text.length <= PINNED_NOTES_CAP) {
      used += text.length;
      included.push({ ...note, content: text });
    } else {
      leftOut.push(note);
    }
  }
  return { included, leftOut, used };
}

// The system prompt as blocks, in this order: base prompt, canvas
// instructions, pinned notes. All of it is stable from one request to the
// next, so the last block carries cache_control and the whole prefix can be
// cached. Nothing that changes per request (times, counters) may go in here.
async function buildSystemBlocks(nodeId) {
  const blocks = [{ type: 'text', text: SYSTEM_PROMPT }];

  const canvas = await pool.query(
    `SELECT c.id, c.instructions
       FROM canvases c
       JOIN nodes n ON n.canvas_id = c.id
      WHERE n.id = $1`,
    [nodeId]
  );
  if (canvas.rowCount > 0) {
    const instructions = (canvas.rows[0].instructions || '').trim();
    if (instructions) {
      blocks.push({
        type: 'text',
        text: `The user has set these instructions for every reply on this canvas. Follow them:\n\n${instructions}`,
      });
    }

    const pinned = await pool.query(
      `SELECT id, content, created_at
         FROM stickies
        WHERE canvas_id = $1 AND in_context
        ORDER BY created_at DESC, id DESC`,
      [canvas.rows[0].id]
    );
    const { included } = selectPinnedNotes(pinned.rows);
    if (included.length > 0) {
      const notes = included.map((note, i) => `Note ${i + 1}:\n${note.content}`).join('\n\n');
      blocks.push({
        type: 'text',
        text: `The user has pinned these notes to this canvas as background. Treat them as facts and preferences to use when relevant:\n\n${notes}`,
      });
    }
  }

  blocks[blocks.length - 1].cache_control = { type: 'ephemeral' };
  return blocks;
}

// --- Live streams ----------------------------------------------------------
// While a node is being answered, its text so far and the connected
// Server-Sent Events clients live here, in memory. The database gets the
// growing reply at most once per second, so a reload, a second tab or the
// polling fallback can always show the partial reply.

const SAVE_INTERVAL_MS = 1000;
const liveStreams = new Map(); // node id -> { text, clients: Set<res> }

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function startLive(nodeId) {
  let live = liveStreams.get(nodeId);
  if (!live) {
    live = { text: '', clients: new Set() };
    liveStreams.set(nodeId, live);
  }
  return live;
}

// Tell every connected client how it ended, then close their connections.
function endLive(nodeId, event, payload) {
  const live = liveStreams.get(nodeId);
  if (!live) return;
  liveStreams.delete(nodeId);
  for (const res of live.clients) {
    try {
      sseSend(res, event, payload);
      res.end();
    } catch { /* client already gone */ }
  }
}

// Answer one pending node, streaming the reply. Never throws: the outcome is
// written to the row and sent to any connected stream clients.
async function answerNode(nodeId) {
  const live = startLive(nodeId);
  let lastSaved = Date.now();
  let saving = false;

  // Save the growing reply, at most once per second and never two at a time.
  // The status check means a late partial save can never overwrite the final reply.
  const savePartial = () => {
    if (saving || Date.now() - lastSaved < SAVE_INTERVAL_MS) return;
    saving = true;
    pool
      // updated_at is left alone: it marks when the wait started, which the page uses for elapsed time.
      .query(`UPDATE nodes SET reply = $2 WHERE id = $1 AND status = 'pending'`, [nodeId, live.text])
      .catch((err) => console.error(`[ai] could not save partial reply for node ${nodeId}: ${err.message}`))
      .finally(() => { saving = false; lastSaved = Date.now(); });
  };

  try {
    const pathRows = await loadPath(nodeId);
    if (pathRows.length === 0) { // node was deleted meanwhile
      endLive(nodeId, 'gone', {});
      return;
    }
    const messages = pathToMessages(pathRows);

    const stream = getAnthropic().messages.stream({
      model: ASK_MODEL,
      max_tokens: MAX_TOKENS,
      system: await buildSystemBlocks(nodeId),
      messages,
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        live.text += event.delta.text;
        for (const res of live.clients) sseSend(res, 'delta', { text: event.delta.text });
        savePartial();
      }
    }
    const response = await stream.finalMessage();

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

    const { rows } = await pool.query(
      `UPDATE nodes
          SET status = 'done', reply = $2, model = $3, error = NULL, updated_at = now()
        WHERE id = $1 AND status = 'pending'
        RETURNING *`,
      [nodeId, reply, response.model || ASK_MODEL]
    );
    if (rows.length > 0) endLive(nodeId, 'done', rows[0]);
    else endLive(nodeId, 'gone', {});
  } catch (err) {
    const message = describeAiError(err);
    console.error(`[ai] node ${nodeId} failed: ${message}`);
    try {
      const { rows } = await pool.query(
        `UPDATE nodes
            SET status = 'error', error = $2, updated_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING *`,
        [nodeId, message]
      );
      if (rows.length > 0) endLive(nodeId, 'failed', rows[0]);
      else endLive(nodeId, 'gone', {});
    } catch (dbErr) {
      console.error(`[ai] could not record the error for node ${nodeId}: ${dbErr.message}`);
      endLive(nodeId, 'gone', {}); // clients fall back to polling
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

// What the page gets for a file: everything except the bytes and the extracted text.
const FILE_COLUMNS = 'id, canvas_id, name, mime, size, status, error, x, y, node_id, context_mode, created_at, updated_at';

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
    `SELECT c.id, c.title, c.created_at, count(n.id)::int AS node_count,
            (SELECT COALESCE(sum(f.size), 0)::float8 FROM files f WHERE f.canvas_id = c.id) AS file_bytes
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
  const canvas = await pool.query('SELECT id, title, created_at, instructions FROM canvases WHERE id = $1', [id]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');
  const [nodes, stickies, files] = await Promise.all([
    pool.query('SELECT * FROM nodes WHERE canvas_id = $1 ORDER BY created_at ASC, id ASC', [id]),
    pool.query('SELECT * FROM stickies WHERE canvas_id = $1 ORDER BY created_at ASC, id ASC', [id]),
    // Metadata only: never the bytes or the extracted text.
    pool.query(`SELECT ${FILE_COLUMNS} FROM files WHERE canvas_id = $1 ORDER BY created_at ASC, id ASC`, [id]),
  ]);
  res.json({ canvas: canvas.rows[0], nodes: nodes.rows, stickies: stickies.rows, files: files.rows });
});

// Save the canvas instructions. Body: { instructions: string | null }.
app.patch('/api/canvases/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Canvas id');
  const body = req.body || {};
  if (body.instructions === undefined) throw new HttpError(400, 'Nothing to update.');
  if (body.instructions !== null && typeof body.instructions !== 'string') {
    throw new HttpError(400, 'instructions must be a string or null.');
  }
  const instructions = body.instructions === null || body.instructions.trim() === '' ? null : body.instructions;
  if (instructions && instructions.length > MAX_INSTRUCTIONS_CHARS) {
    throw new HttpError(400, `instructions are too long (max ${MAX_INSTRUCTIONS_CHARS} characters).`);
  }
  const { rows } = await pool.query(
    'UPDATE canvases SET instructions = $2 WHERE id = $1 RETURNING id, title, created_at, instructions',
    [id, instructions]
  );
  if (rows.length === 0) throw new HttpError(404, 'Canvas not found.');
  res.json(rows[0]);
});

// Save many node positions in one request (used by Tidy layout and its undo).
// Body: { positions: [{ id, x, y }, ...] }. Only nodes on this canvas are touched.
app.patch('/api/canvases/:id/positions', async (req, res) => {
  const canvasId = requireUuid(req.params.id, 'Canvas id');
  const list = req.body && req.body.positions;
  if (!Array.isArray(list) || list.length === 0) {
    throw new HttpError(400, 'positions must be a non-empty array of { id, x, y }.');
  }
  if (list.length > MAX_BATCH_POSITIONS) {
    throw new HttpError(400, `Too many positions in one request (max ${MAX_BATCH_POSITIONS}).`);
  }
  const ids = [];
  const xs = [];
  const ys = [];
  for (const item of list) {
    if (!item || typeof item !== 'object') throw new HttpError(400, 'Each position must be an object { id, x, y }.');
    ids.push(requireUuid(item.id, 'Position id'));
    xs.push(readCoord(item.x, 'x', { required: true }));
    ys.push(readCoord(item.y, 'y', { required: true }));
  }

  const canvas = await pool.query('SELECT id FROM canvases WHERE id = $1', [canvasId]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');

  // One statement, so the whole layout is saved or none of it is.
  // updated_at is left alone: it marks when a pending node's wait started.
  const { rowCount } = await pool.query(
    `UPDATE nodes AS n
        SET x = v.x, y = v.y
       FROM unnest($2::uuid[], $3::real[], $4::real[]) AS v(id, x, y)
      WHERE n.id = v.id AND n.canvas_id = $1`,
    [canvasId, ids, xs, ys]
  );
  res.json({ ok: true, updated: rowCount });
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
  startLive(rows[0].id);
  res.status(201).json(rows[0]);
  answerNode(rows[0].id);
});

app.get('/api/nodes/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Node id');
  const { rows } = await pool.query('SELECT * FROM nodes WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'Node not found.');
  res.json(rows[0]);
});

// Server-Sent Events for one node. Events:
//   snapshot { text }  the reply so far, sent once on connect
//   delta    { text }  the next piece of text
//   done     node      finished; the connection then closes
//   failed   node      the AI call failed; the connection then closes
//   gone     {}        nothing to stream here; the client should poll instead
app.get('/api/nodes/:id/stream', async (req, res) => {
  const id = requireUuid(req.params.id, 'Node id');

  const open = () => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
  };

  // Checked before any await, so nothing can be missed between the snapshot
  // and the first delta.
  const live = liveStreams.get(id);
  if (live) {
    open();
    sseSend(res, 'snapshot', { text: live.text });
    live.clients.add(res);
    // Comment lines keep proxies from closing a quiet connection.
    const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 15000);
    req.on('close', () => {
      clearInterval(heartbeat);
      live.clients.delete(res);
    });
    return;
  }

  const { rows } = await pool.query('SELECT * FROM nodes WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'Node not found.');
  open();
  const node = rows[0];
  if (node.status === 'done') sseSend(res, 'done', node);
  else if (node.status === 'error') sseSend(res, 'failed', node);
  else sseSend(res, 'gone', {});
  res.end();
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
        SET status = 'pending', error = NULL, reply = NULL, updated_at = now()
      WHERE id = $1 AND status = 'error'
      RETURNING *`,
    [id]
  );
  if (rows.length === 0) {
    const existing = await pool.query('SELECT status FROM nodes WHERE id = $1', [id]);
    if (existing.rowCount === 0) throw new HttpError(404, 'Node not found.');
    throw new HttpError(409, `Only an error node can be retried (status: ${existing.rows[0].status}).`);
  }
  startLive(id);
  res.json(rows[0]);
  answerNode(id);
});

// --- Stickies --------------------------------------------------------------

function readStickyColor(value) {
  if (typeof value !== 'string' || !STICKY_COLORS.includes(value)) {
    throw new HttpError(400, `color must be one of: ${STICKY_COLORS.join(', ')}.`);
  }
  return value;
}

function readStickyContent(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'content must be a string.');
  if (value.length > MAX_STICKY_CHARS) {
    throw new HttpError(400, `content is too long (max ${MAX_STICKY_CHARS} characters).`);
  }
  return value;
}

// A sticky can only be attached to a node on its own canvas.
async function requireNodeOnCanvas(nodeId, canvasId) {
  const node = await pool.query('SELECT canvas_id FROM nodes WHERE id = $1', [nodeId]);
  if (node.rowCount === 0 || node.rows[0].canvas_id !== canvasId) {
    throw new HttpError(400, 'node_id does not refer to a node on this canvas.');
  }
}

app.post('/api/canvases/:id/stickies', async (req, res) => {
  const canvasId = requireUuid(req.params.id, 'Canvas id');
  const body = req.body || {};
  const x = readCoord(body.x, 'x', { required: false });
  const y = readCoord(body.y, 'y', { required: false });
  const color = body.color === undefined ? 'yellow' : readStickyColor(body.color);
  const content = body.content === undefined ? '' : readStickyContent(body.content);
  const nodeId = body.node_id === undefined || body.node_id === null ? null : requireUuid(body.node_id, 'node_id');

  const canvas = await pool.query('SELECT id FROM canvases WHERE id = $1', [canvasId]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');
  if (nodeId) await requireNodeOnCanvas(nodeId, canvasId);

  const { rows } = await pool.query(
    `INSERT INTO stickies (canvas_id, node_id, x, y, color, content)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING *`,
    [canvasId, nodeId, x, y, color, content]
  );
  res.status(201).json(rows[0]);
});

// Partial update: only the fields present in the body change.
app.patch('/api/stickies/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Sticky id');
  const body = req.body || {};

  const existing = await pool.query('SELECT canvas_id FROM stickies WHERE id = $1', [id]);
  if (existing.rowCount === 0) throw new HttpError(404, 'Sticky not found.');

  const sets = [];
  const values = [id];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (body.content !== undefined) set('content', readStickyContent(body.content));
  if (body.color !== undefined) set('color', readStickyColor(body.color));
  if (body.x !== undefined) set('x', readCoord(body.x, 'x', { required: true }));
  if (body.y !== undefined) set('y', readCoord(body.y, 'y', { required: true }));
  if (body.in_context !== undefined) {
    if (typeof body.in_context !== 'boolean') throw new HttpError(400, 'in_context must be true or false.');
    set('in_context', body.in_context);
  }
  if (body.node_id !== undefined) {
    const nodeId = body.node_id === null ? null : requireUuid(body.node_id, 'node_id');
    if (nodeId) await requireNodeOnCanvas(nodeId, existing.rows[0].canvas_id);
    set('node_id', nodeId);
  }
  if (sets.length === 0) throw new HttpError(400, 'Nothing to update.');

  const { rows } = await pool.query(
    `UPDATE stickies SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING *`,
    values
  );
  if (rows.length === 0) throw new HttpError(404, 'Sticky not found.');
  res.json(rows[0]);
});

app.delete('/api/stickies/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'Sticky id');
  const { rowCount } = await pool.query('DELETE FROM stickies WHERE id = $1', [id]);
  if (rowCount === 0) throw new HttpError(404, 'Sticky not found.');
  res.json({ ok: true, id });
});

// --- Files -----------------------------------------------------------------

// One file per request, held in memory, never more than MAX_FILE_BYTES.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 10, fieldSize: 2000 },
});

function receiveUpload(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(new HttpError(413, 'File too large (max 10 MB).'));
      return next(new HttpError(400, `Upload refused: ${err.message}.`));
    }
    next(new HttpError(400, 'The upload could not be read. Try again.'));
  });
}

function readFileName(value) {
  if (typeof value !== 'string') throw new HttpError(400, 'name must be a string.');
  // No path parts, no control characters.
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').split(/[\\/]/).pop().trim();
  if (!name) throw new HttpError(400, 'name must not be empty.');
  return name.slice(0, MAX_FILE_NAME_CHARS);
}

const startsWith = (buf, bytes, offset = 0) =>
  buf.length >= offset + bytes.length && bytes.every((b, i) => buf[offset + i] === b);

// Does the content match what the extension says? Stops a renamed .exe.
function looksLike(ext, buf) {
  switch (ext) {
    case 'pdf': return buf.subarray(0, 1024).includes('%PDF-');
    case 'png': return startsWith(buf, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    case 'jpg':
    case 'jpeg': return startsWith(buf, [0xff, 0xd8, 0xff]);
    case 'gif': return startsWith(buf, [0x47, 0x49, 0x46, 0x38]);
    case 'webp': return startsWith(buf, [0x52, 0x49, 0x46, 0x46]) && startsWith(buf, [0x57, 0x45, 0x42, 0x50], 8);
    case 'docx': return startsWith(buf, [0x50, 0x4b, 0x03, 0x04]);
    default: return true;
  }
}

// Text files: UTF-8 where it is valid, otherwise read byte for byte (Latin-1,
// common for CSV exports). Anything with NUL bytes is not text.
function decodeText(buf) {
  if (buf.includes(0)) return null;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    text = buf.toString('latin1');
  }
  return text.replace(/^\uFEFF/, '');
}

// RFC 6266: an ASCII fallback plus the real name, percent-encoded.
function contentDisposition(type, name) {
  const fallback = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// Multipart upload. Fields: file (required), name, x, y, node_id.
app.post('/api/canvases/:id/files', receiveUpload, async (req, res) => {
  const canvasId = requireUuid(req.params.id, 'Canvas id');
  const body = req.body || {};
  if (!req.file) throw new HttpError(400, 'No file was sent.');

  // multer reads the multipart file name as Latin-1, so the page also sends it as a field.
  const name = readFileName(typeof body.name === 'string' && body.name ? body.name : req.file.originalname);
  const ext = name.includes('.') ? name.split('.').pop().toLowerCase() : '';
  const type = FILE_TYPES[ext];
  if (!type) {
    throw new HttpError(415, `This file type is not supported${ext ? ` (.${ext})` : ''}. Accepted: ${ACCEPTED_LABEL}.`);
  }
  const data = req.file.buffer;
  if (data.length === 0) throw new HttpError(400, 'The file is empty.');
  if (!looksLike(ext, data)) {
    throw new HttpError(415, `This does not look like a real .${ext} file, so it was refused.`);
  }

  const num = (value, label) => {
    if (value === undefined || value === '') return 0;
    const n = Number(value);
    if (!Number.isFinite(n)) throw new HttpError(400, `${label} must be a number.`);
    return n;
  };
  const x = num(body.x, 'x');
  const y = num(body.y, 'y');
  const nodeId = body.node_id ? requireUuid(body.node_id, 'node_id') : null;

  const canvas = await pool.query('SELECT id FROM canvases WHERE id = $1', [canvasId]);
  if (canvas.rowCount === 0) throw new HttpError(404, 'Canvas not found.');
  if (nodeId) await requireNodeOnCanvas(nodeId, canvasId);

  // Extract text now, so it is ready for previews, search and the AI.
  let text = null;
  let status = 'ready';
  let error = null;
  if (type.kind === 'text') {
    text = decodeText(data);
    if (text === null) throw new HttpError(415, `This does not look like a text file, so it was refused.`);
  } else if (type.kind === 'word') {
    try {
      const result = await mammoth.extractRawText({ buffer: data });
      text = (result.value || '').replace(/\u0000/g, '').trim();
    } catch (err) {
      console.error(`[files] could not read Word file "${name}": ${err.message}`);
      status = 'error';
      error = 'The text of this Word file could not be read. The file itself is saved and can be downloaded.';
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO files (canvas_id, name, mime, size, data, text_content, status, error, x, y, node_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${FILE_COLUMNS}`,
    [canvasId, name, type.mime, data.length, data, text, status, error, x, y, nodeId]
  );
  res.status(201).json(rows[0]);
});

app.get('/api/files/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'File id');
  const { rows } = await pool.query(`SELECT ${FILE_COLUMNS} FROM files WHERE id = $1`, [id]);
  if (rows.length === 0) throw new HttpError(404, 'File not found.');
  res.json(rows[0]);
});

// The file's bytes. Never served as HTML: the type comes from our own table,
// the browser may not guess another one, and only PDFs and images are shown
// inline. ?download=1 always downloads.
app.get('/api/files/:id/content', async (req, res) => {
  const id = requireUuid(req.params.id, 'File id');
  const { rows } = await pool.query('SELECT name, mime, data FROM files WHERE id = $1', [id]);
  if (rows.length === 0) throw new HttpError(404, 'File not found.');
  const file = rows[0];
  const inline = INLINE_MIMES.has(file.mime) && req.query.download === undefined;
  res.set({
    'Content-Type': file.mime,
    'Content-Length': String(file.data.length),
    'Content-Disposition': contentDisposition(inline ? 'inline' : 'attachment', file.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'private, max-age=3600',
  });
  // Nothing in a served file may run scripts or load anything. (Left off for
  // PDFs, where it would stop the browser's own PDF viewer.)
  if (file.mime !== 'application/pdf') res.set('Content-Security-Policy', "default-src 'none'; sandbox");
  res.end(file.data);
});

// The file's text (txt, md, csv, and the text extracted from docx), loaded on
// demand for previews and the reader. ?limit=N returns the first N characters.
app.get('/api/files/:id/text', async (req, res) => {
  const id = requireUuid(req.params.id, 'File id');
  let limit = MAX_FILE_TEXT_RESPONSE;
  if (req.query.limit !== undefined) {
    const n = Number(req.query.limit);
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'limit must be a positive whole number.');
    limit = Math.min(n, MAX_FILE_TEXT_RESPONSE);
  }
  const { rows } = await pool.query(
    `SELECT status, error, text_content IS NOT NULL AS has_text,
            left(text_content, $2) AS text, char_length(text_content) AS total
       FROM files WHERE id = $1`,
    [id, limit]
  );
  if (rows.length === 0) throw new HttpError(404, 'File not found.');
  const file = rows[0];
  if (!file.has_text) {
    throw new HttpError(404, file.status === 'error' && file.error ? file.error : 'This file has no text to show.');
  }
  res.json({ text: file.text, total: file.total, truncated: file.total > file.text.length });
});

// Partial update: only the fields present in the body change.
app.patch('/api/files/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'File id');
  const body = req.body || {};

  const existing = await pool.query('SELECT canvas_id, node_id, context_mode, name FROM files WHERE id = $1', [id]);
  if (existing.rowCount === 0) throw new HttpError(404, 'File not found.');
  const current = existing.rows[0];

  const sets = [];
  const values = [id];
  const set = (column, value) => { values.push(value); sets.push(`${column} = $${values.length}`); };

  if (body.x !== undefined) set('x', readCoord(body.x, 'x', { required: true }));
  if (body.y !== undefined) set('y', readCoord(body.y, 'y', { required: true }));
  if (body.name !== undefined) {
    const name = readFileName(body.name);
    // The extension decides how the file is treated, so a rename must keep it.
    const ext = (n) => (n.includes('.') ? n.split('.').pop().toLowerCase() : '');
    if (ext(name) !== ext(current.name)) throw new HttpError(400, `The name must keep the file's ending (.${ext(current.name)}).`);
    set('name', name);
  }
  let nodeId = current.node_id;
  if (body.node_id !== undefined) {
    nodeId = body.node_id === null ? null : requireUuid(body.node_id, 'node_id');
    if (nodeId) await requireNodeOnCanvas(nodeId, current.canvas_id);
    set('node_id', nodeId);
  }
  let mode = current.context_mode;
  if (body.context_mode !== undefined) {
    if (!CONTEXT_MODES.includes(body.context_mode)) {
      throw new HttpError(400, `context_mode must be one of: ${CONTEXT_MODES.join(', ')}.`);
    }
    mode = body.context_mode;
    if (mode === 'branch' && !nodeId) throw new HttpError(400, 'context_mode "branch" needs the file to be attached to a node.');
    set('context_mode', mode);
  } else if (mode === 'branch' && !nodeId) {
    set('context_mode', 'off'); // detached: there is no branch left to scope to
  }
  if (sets.length === 0) throw new HttpError(400, 'Nothing to update.');

  const { rows } = await pool.query(
    `UPDATE files SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 RETURNING ${FILE_COLUMNS}`,
    values
  );
  if (rows.length === 0) throw new HttpError(404, 'File not found.');
  res.json(rows[0]);
});

app.delete('/api/files/:id', async (req, res) => {
  const id = requireUuid(req.params.id, 'File id');
  const { rowCount } = await pool.query('DELETE FROM files WHERE id = $1', [id]);
  if (rowCount === 0) throw new HttpError(404, 'File not found.');
  res.json({ ok: true, id });
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

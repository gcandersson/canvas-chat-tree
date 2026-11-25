# Brief 001 — canvas-chat-tree v0.1

## Goal
A working, deployed first version: an infinite canvas where each AI exchange is a node card, conversations can branch from any node, and the AI answers using only the path to that node.

## Out of scope for v0.1
Stickies, minimap, subtree collapse, projects panel, file uploads, streaming replies, multi-user accounts, deleting nodes, markdown rendering. (All go in the README roadmap.)

## Data model
canvases
  id uuid primary key default gen_random_uuid()
  title text not null default 'Untitled canvas'
  created_at timestamptz not null default now()

nodes
  id uuid primary key default gen_random_uuid()
  canvas_id uuid not null references canvases(id) on delete cascade
  parent_id uuid null references nodes(id) on delete cascade
  prompt text not null
  reply text null
  status text not null default 'pending'   -- pending | done | error
  error text null
  model text null
  x real not null default 0
  y real not null default 0
  created_at timestamptz not null default now()
  updated_at timestamptz not null default now()
  index on nodes(canvas_id), index on nodes(parent_id)

Enable the pgcrypto extension on start (CREATE EXTENSION IF NOT EXISTS pgcrypto).

## Access
All routes, including the static page, sit behind HTTP Basic Auth when APP_PASSWORD is set (any username, password = APP_PASSWORD). This stops strangers spending Gustav's API credits. /api/health stays open.

## API
GET  /api/health → { ok: true, db: true|false, model: ASK_MODEL }
GET  /api/canvases → list (id, title, created_at, node_count), newest first
POST /api/canvases { title? } → new canvas
GET  /api/canvases/:id → { canvas, nodes: [...] }
POST /api/canvases/:id/nodes { parent_id: uuid|null, prompt, x, y }
     → inserts the node as pending, returns it immediately, then calls the AI in the background and updates the row to done (reply, model) or error (error text)
GET  /api/nodes/:id → the node (used by the frontend to poll a pending node)
PATCH /api/nodes/:id { x, y } → saves a dragged position
POST /api/nodes/:id/retry → sets an error node back to pending and calls the AI again

## Path assembly (the core rule)
To answer node N: walk parent_id from N up to its root, reverse the list, and send it to the AI as alternating messages: for each ancestor, { role: user, content: prompt } then { role: assistant, content: reply }, ending with N's own prompt as the last user message. Never include sibling branches. Use ASK_MODEL, max_tokens 2048, and a short system prompt saying the user is exploring ideas on a branching canvas.

## Frontend (public/index.html)
- Dark theme, clean and minimal.
- Top bar: canvas switcher, "New canvas", canvas title (editable is out of scope), zoom percentage, "Fit to screen".
- Infinite canvas: drag empty space to pan; mouse wheel / trackpad zooms towards the cursor; pinch zoom on trackpads; zoom range 10%–200%.
- Node cards (about 360px wide): prompt at the top (bold), reply below (pre-wrapped text, scroll inside the card if long), and two buttons: "Continue" and "Branch".
  - Continue opens the composer and places the new child directly below.
  - Branch opens the composer and places the new child to the right of the existing children, so branches fan out side by side.
- Edges: smooth curved SVG lines from parent bottom-centre to child top-centre.
- Empty canvas: a centred composer saying "Start a conversation". A "New conversation" button in the top bar places a new root node at the centre of the viewport.
- Pending node: spinner and "Thinking… 7s" counting up; the frontend polls GET /api/nodes/:id every 1.5s until done or error.
- Error node: red border, the error message, and a "Retry" button.
- Drag a node card by its header to move it; save the position on release (PATCH).
- Every network action shows its state (saving, loading, failed with retry).

## Units (one at a time; Gustav deploys and verifies after each)
Unit 0 — Scaffold: CLAUDE.md, UBIQUITOUS_LANGUAGE.md, this brief, README.md, .gitignore (node_modules, .env, .DS_Store), .env.example (variable names only, no values), package.json (start script "node server.js", engines node >=20), server.js with Basic Auth, schema creation on start and GET /api/health, and a placeholder public/index.html saying "canvas-chat-tree is running".
  Verify: after `railway up`, open https://canvas-chat-tree-production.up.railway.app/api/health → ok true, db true. In Beekeeper, tables canvases and nodes exist.
Unit 1 — API: all endpoints above plus path assembly and the AI call.
  Verify with curl: create a canvas, a root node, a child, and a branch from the root; GET the canvas; confirm the branch's reply does not reference the sibling's content.
Unit 2 — Canvas render: load a canvas, draw node cards and edges, pan, zoom to cursor, pinch, fit to screen, canvas switcher.
  Verify on the live URL with the nodes from Unit 1.
Unit 3 — Composer, Continue, Branch, pending and error states, retry.
  Verify: build a conversation with two branches from the same node, watch the pending timer, force an error (temporarily wrong model name in ASK_MODEL) and retry after fixing it.
Unit 4 — Drag to move (persisted), README with screenshots, live demo note and roadmap. Rename this brief to __shipped.
  Verify: move a node, reload, it stays put; README renders on GitHub.

## README contents (written in Unit 0, completed in Unit 4)
Name and one-line description; why (linear chat gets messy when you think in branches); features; tech stack; run locally (npm install, set env vars from .env.example, npm start); deploy on Railway; roadmap (stickies, minimap, subtree collapse, projects with shared context, streaming replies, markdown); licence MIT, © 2026 Gustav Andersson.

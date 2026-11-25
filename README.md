# canvas-chat-tree

An infinite canvas where every AI chat exchange is a node, and any node can be branched.

![A canvas with one conversation that splits into three branches](docs/canvas-overview.png)

## Why

Linear chat gets messy when you think in branches. You ask a question, get an answer, and want to explore two follow-ups without one polluting the other. In a normal chat you either scroll up and lose your place, or open a new chat and lose the context.

canvas-chat-tree lays the conversation out as a tree on a canvas. Each exchange (your prompt plus the AI's reply) is a card. You can continue from any card or branch from it, and the AI only ever sees the path from the root to the card it is answering, never the sibling branches.

![Branching from a node: the composer and the outline where the new node will land](docs/canvas-branch.png)

The screenshots show a demo canvas with invented content.

## Features

- Infinite canvas: drag to pan, wheel or trackpad to zoom towards the cursor, pinch zoom, fit to screen
- Every exchange is a node card; **Continue** adds a follow-up below, **Branch** starts a new direction beside it
- The AI answers using only the path to that node, so branches never leak into each other
- Curved edges from parent to child
- Basic Markdown in replies (bold, headings, lists, code), sanitised
- A pending node shows a spinner and elapsed seconds; a failed node shows the error and a Retry button
- Drag a node by its header to rearrange; positions are saved
- Several canvases, with a switcher
- Optional password protection (HTTP Basic Auth)

## Live demo

There is no public demo. The author's own instance is password-protected, because every prompt spends API credits. To try it, run it locally or deploy your own copy; both take a few minutes.

## Tech stack

- Node.js (20 or newer) + Express
- Postgres, via the `pg` driver
- Anthropic API, via `@anthropic-ai/sdk`
- Frontend: a single HTML file ([public/index.html](public/index.html)) using Preact + htm and micromark from esm.sh, with no build step

The schema (two tables, `canvases` and `nodes`) is created automatically when the server starts.

## Run locally

You need Node.js 20 or newer, a Postgres database and an Anthropic API key.

```bash
npm install
```

Set the environment variables listed in `.env.example`:

| Variable | What it is |
| --- | --- |
| `DATABASE_URL` | Postgres connection string |
| `ANTHROPIC_API_KEY` | Your Anthropic API key |
| `APP_PASSWORD` | Optional. When set, everything except `/api/health` requires HTTP Basic Auth (any username, this password) |
| `ASK_MODEL` | Optional. Model used for replies. Defaults to `claude-sonnet-5-5` |
| `PORT` | Optional. Defaults to `8080` |

The server reads them from the process environment (it does not load a `.env` file by itself). Then:

```bash
npm start
```

Open http://localhost:8080. `GET /api/health` returns `{ "ok": true, "db": true, "model": "..." }` when the database is reachable.

## Deploy on Railway

1. Create a Railway project with a Postgres service and an empty service for the app.
2. On the app service, set `DATABASE_URL` (reference the Postgres service), `ANTHROPIC_API_KEY`, `APP_PASSWORD` and optionally `ASK_MODEL`.
3. From the repo folder, run `railway link` and choose the project and the app service, then `railway up`.
4. Generate a public domain for the app service and open `/api/health` on it. The server listens on `PORT`.

Set `APP_PASSWORD` before sharing the URL with anyone: without it, anybody who finds the page can spend your API credits.

## API

| Method and path | What it does |
| --- | --- |
| `GET /api/health` | `{ ok, db, model }`. Always open, even with a password set |
| `GET /api/canvases` | List canvases with `node_count`, newest first |
| `POST /api/canvases` | Create a canvas. Body: `{ title? }` |
| `GET /api/canvases/:id` | `{ canvas, nodes }` |
| `POST /api/canvases/:id/nodes` | Create a node. Body: `{ parent_id, prompt, x, y }`. Returns it as `pending`, then answers in the background |
| `GET /api/nodes/:id` | One node; the page polls this while a node is pending |
| `PATCH /api/nodes/:id` | Save a position. Body: `{ x, y }` |
| `POST /api/nodes/:id/retry` | Ask the AI again for a node in `error` |

## Roadmap

- Stickies
- Minimap
- Subtree collapse
- Projects with shared context
- Streaming replies
- Richer Markdown (tables, syntax highlighting)
- Deleting nodes and renaming canvases
- File uploads
- Multi-user accounts

## Licence

MIT. © 2026 Gustav Andersson. See [LICENSE](LICENSE).

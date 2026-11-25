# canvas-chat-tree

An infinite canvas where every AI chat exchange is a node, and any node can be branched.

> Status: early work in progress. v0.1 is being built one unit at a time; sections marked "coming in v0.1" are not finished yet.

## Why

Linear chat gets messy when you think in branches. You ask a question, get an answer, and want to explore two follow-ups without one polluting the other. In a normal chat you either scroll up and lose your place, or open a new chat and lose the context.

canvas-chat-tree lays the conversation out as a tree on a canvas. Each exchange (your prompt plus the AI's reply) is a card. You can continue from any card or branch from it, and the AI only ever sees the path from the root to the card it is answering, never the sibling branches.

## Features

Coming in v0.1:

- Infinite canvas: pan, zoom towards the cursor, pinch zoom, fit to screen
- Every exchange is a node card; continue or branch from any node
- The AI answers using only the path to that node
- Curved edges from parent to child
- Pending state with an elapsed-time counter, error state with retry
- Drag nodes to rearrange; positions are saved
- Several canvases, with a switcher
- Optional password protection (HTTP Basic Auth)

Available now: everything above except dragging nodes to rearrange them, which is next.

## Tech stack

- Node.js (20 or newer) + Express
- Postgres, via the `pg` driver
- Anthropic API, via `@anthropic-ai/sdk`
- Frontend: a single HTML file using Preact + htm from esm.sh, no build step

## Run locally

You need Node.js 20 or newer and a Postgres database.

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

Open http://localhost:8080. The tables are created automatically on start. `GET /api/health` returns `{ "ok": true, "db": true, "model": "..." }` when the database is reachable.

## Deploy on Railway

1. Create a Railway project with a Postgres service and an empty service for the app.
2. On the app service, set `DATABASE_URL` (reference the Postgres service), `ANTHROPIC_API_KEY`, `APP_PASSWORD` and optionally `ASK_MODEL`.
3. From the repo folder, run `railway link` and choose the project and the app service, then `railway up`.
4. Generate a public domain for the app service and open `/api/health` on it.

Fuller instructions and a live demo note: coming in v0.1.

## Roadmap

After v0.1:

- Stickies
- Minimap
- Subtree collapse
- Projects with shared context
- Streaming replies
- Markdown rendering

## Licence

MIT. © 2026 Gustav Andersson. See [LICENSE](LICENSE).

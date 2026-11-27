# Brief 003 — canvas-chat-tree v0.3: Bring your own material

## Goal
Let me bring my own material into a canvas and control exactly which part of a conversation can use it. Files, notes and links become bubbles on the canvas. A bubble can be attached to a node, so that node and every node below it can use it, or pinned to the whole canvas. The AI only ever sees material that is on the node's path or pinned to the canvas, and each node shows exactly what it can see. Plus quick capture by pasting, search, and folders to organise many canvases.

## Core rule (extends the path rule)
A node's AI context is: base system prompt, canvas instructions, everything pinned to the canvas, then the path from the root to the node, where each node on the path carries the material attached to it. Material attached to a sibling branch is never seen. Attaching material to a node that already has a reply does not change that reply; it applies to new children of that node and below.

## Design rules
- Keep the current look in both themes. New bubbles use the same card language as nodes and stickies, with a type icon (PDF, image, text, Word, link).
- Progress feedback everywhere: upload progress bar with percentage, processing state, clear errors with Retry.
- Additive, idempotent schema changes only. Never drop or rename anything.
- No real personal data in the repo, screenshots or test fixtures. Create invented test files (for example a one-page PDF "Fictional supplier quote: Nordic Widgets AB, unit price 4,200 SEK").

## Known pitfalls to design around from the start
1. Uploads: use multipart uploads (multer, memory storage) with a hard 10 MB per-file limit and a clear "File too large (max 10 MB)" message. Do not raise express.json limits for this. Show real upload progress.
2. Serving files safely: never serve uploaded content as HTML. Serve bytes from GET /api/files/:id/content with the stored MIME type, Content-Disposition (inline only for PDF and images, attachment for everything else), X-Content-Type-Options: nosniff. Render text, markdown and extracted Word text through the existing sanitised markdown path or as plain text.
3. Payload size: GET /api/canvases/:id returns file metadata only, never file bytes or full extracted text. Previews load on demand.
4. Link fetching (SSRF): only http and https; resolve DNS and refuse private, loopback, link-local and metadata addresses (10/8, 172.16/12, 192.168/16, 127/8, 169.254/16, ::1, fc00::/7, fe80::/10, 0.0.0.0) including after redirects (max 3 redirects); 10-second timeout; max 2 MB response; only text/html and text/plain.
5. AI context budget: per request at most 40,000 characters of text material (notes, text files, Word text, link text), at most 3 PDFs (max 100 pages each), at most 5 images, and keep the total request comfortably inside the model's limits. Anything over budget is left out (closest-to-the-node first wins, canvas-pinned last) and shown as excluded with the reason.
6. Prompt caching: put the stable material first, as now. Canvas-pinned files and notes go at the start of the first user message of the path, before the root prompt, with cache_control on the last of those blocks. Branch-attached material goes into the user message of the node it is attached to, before that node's prompt. Nothing that changes per request goes inside cached blocks.
7. Pointer handling: same rules as brief 002 (5px threshold, buttons and inputs never start drags). Dropping a file onto a card highlights the card as a drop target before release.
8. Database growth: files are stored in Postgres (bytea). Show total stored size per canvas in the canvas menu and warn above 200 MB.

## Units

### Unit 1 — File bubbles
- New table files: id uuid pk, canvas_id uuid fk on delete cascade, name text, mime text, size int, data bytea, text_content text null (extracted text for txt, md, csv and docx; null for PDF and images), status text default 'ready' (processing | ready | error), error text null, x real, y real, node_id uuid null fk nodes on delete set null, context_mode text default 'off', created_at, updated_at.
- Accepted types: PDF, PNG, JPG, WEBP, GIF, TXT, MD, CSV, DOCX (Word text extracted server-side with mammoth). Anything else is refused with a clear message.
- Add files by: an "+ File" button in the top bar (file picker, multiple files), or dragging files from the computer onto the canvas (bubble lands at the drop point). Dragging onto a card creates the bubble next to that card and attached to it (node_id set, context_mode still 'off' until Unit 2).
- File bubble: about 220px wide, type icon, file name, size, small preview (first page thumbnail is not required; show an image thumbnail for images, the first lines for text, an icon for PDF and Word). Drag to move, delete with an in-bubble confirm.
- Clicking a bubble opens it in the reader panel: images shown, PDFs in an embedded viewer, text and Word as rendered text, plus Download.
- API: POST /api/canvases/:id/files (multipart), GET /api/files/:id (metadata), GET /api/files/:id/content, PATCH /api/files/:id (x, y, node_id, context_mode, name), DELETE /api/files/:id.
- Attached file bubbles follow their card like attached stickies (offset storage), and Tidy carries them along.
Verify: upload one of each type, see bubbles and previews, open each in the reader, drag, reload and everything persists; drop a file onto a card and it attaches and follows the card; a 12 MB file is refused with a clear message; an .exe is refused.

### Unit 2 — Attach and scope (one context model for files and stickies)
- Add stickies.context_mode text default 'off' (values: off | branch | canvas). On start, idempotently set context_mode = 'canvas' where in_context = true and context_mode = 'off'. From now on context_mode is the source of truth; keep writing in_context = (context_mode = 'canvas') for backwards compatibility.
- Every sticky and file bubble gets a small context control with three states: Off, This branch (only allowed when attached to a node; shows the node's title), Whole canvas.
- Attaching: drag a short connector from a bubble's attach handle onto a card, or use "Attach to…" from the bubble menu and then click a card. Detach from the menu. Attaching or detaching never moves the card.
- Visuals: branch-scoped bubbles show a branch icon and their connector in the card's accent colour; canvas-pinned show the pin badge as today.
- Context chips on each card header: small chips for what that node can see (up to 3, then "+N"), covering canvas-pinned items, items attached to ancestors and items attached to the node itself. Chips are computed on screen, not stored.
- The Context panel (from brief 002) gets two sections: Whole canvas (pinned notes and files) and Attached to branches (grouped by node, click to jump).
Verify: attach a note to branch A with context "This branch"; nodes under A show the chip, nodes in sibling branch B do not; switch it to "Whole canvas" and every node shows it; old pinned stickies still show as Whole canvas after deploy.

### Unit 3 — The AI uses attached material
- Context assembly follows the core rule and pitfalls 5 and 6. PDFs are sent as document blocks and images as image blocks (base64 from the database); notes, text, CSV, Word text and link text as text blocks labelled with their type and name, for example "[File: quote.pdf]" or "[Note]".
- "What this node sees": a section at the top of the reader panel for any node, listing every context item with its scope (canvas or which ancestor it is attached to), and whether it was included or left out with the reason (budget, unsupported, error).
- When a reply was generated, store which context items were included (new column nodes.context_used jsonb, list of {type, id, name}) so the reader shows what a past reply actually used, even if attachments changed later.
Verify (invented data): attach the fictional supplier quote PDF to branch A ("This branch"), ask in a new child of A "What is the unit price in the quote?" and get 4,200 SEK; ask the same in a new node in sibling branch B and it does not know; pin an invented image (for example a simple chart) to the whole canvas and ask about it from any branch; exceed the budget with large text files and see the excluded items and reasons listed.

### Unit 4 — Quick capture and link bubbles
- Paste onto the canvas (Cmd/Ctrl+V when no text field is focused): plain text becomes a new sticky at the cursor; a single URL becomes a link bubble; an image on the clipboard becomes an image file bubble. If a card is selected when pasting, the new bubble is attached to it.
- New table links: id uuid pk, canvas_id fk on delete cascade, url text, title text null, text_content text null, status (processing | ready | error), error text null, x, y, node_id null fk nodes on delete set null, context_mode default 'off', fetched_at, created_at, updated_at. API mirrors files (POST, PATCH, DELETE, POST /api/links/:id/refresh).
- The server fetches the page following pitfall 4, extracts the main readable text (@mozilla/readability with jsdom, falling back to plain text) capped at 20,000 characters, and stores title and text. Bubble shows title, domain, fetched date, and a Refresh button. Link text is used in context like other text material.
- "+ Link" in the top bar as an alternative to pasting.
Verify: paste a paragraph and get a sticky; paste a public article URL and get a link bubble with title and readable text in the reader; paste http://localhost and http://169.254.169.254 and both are refused with a clear message; attach a link to a branch and ask about its content from that branch.

### Unit 5 — Search
- Search box in the top bar, opened by clicking or Cmd/Ctrl+K. Searches the current canvas by default, with a toggle for all canvases.
- Covers node prompts and replies, sticky text, file names and extracted text, and link titles and text. Server endpoint GET /api/search?q=&canvas_id= (case-insensitive, at least 2 characters, max 50 results, ranked with titles and prompts before body text).
- Results list shows type icon, the matching snippet with the term highlighted, and canvas name when searching all. Choosing a result switches canvas if needed, expands any collapsed ancestor, pans and zooms to the item and briefly highlights it.
Verify: search a word that appears in a reply deep in a collapsed branch and it expands and jumps there; search a word inside a Word file and it finds the file bubble; all-canvases search jumps across canvases.

### Unit 6 — Folders and canvas names
- Canvas titles become editable (click the title in the top bar, Enter to save).
- New table folders: id uuid pk, name text, position int, created_at, updated_at. New column canvases.folder_id uuid null fk on delete set null.
- A collapsible left sidebar lists folders with their canvases, plus "Unfiled". Create, rename and delete folders (deleting a folder moves its canvases to Unfiled, never deletes canvases). Move a canvas by dragging it onto a folder or with "Move to folder" in its menu. The sidebar remembers open/closed state in localStorage. The existing canvas switcher stays for quick access.
Verify: create folders "Work", "Personal", "Experiments", move canvases between them, rename a canvas and a folder, delete a folder and its canvases appear under Unfiled, reload and everything persists.

## New ubiquitous language
Bubble: any item placed on the canvas besides a node: a sticky, a file or a link.
File bubble: an uploaded file shown on the canvas.
Link bubble: a web page saved on the canvas with its readable text.
Context item: any bubble that can be given to the AI.
Context mode: Off, This branch or Whole canvas, set per context item.
Branch context: a context item attached to a node with mode This branch; that node and all its descendants can use it.
Canvas context: a context item with mode Whole canvas; every node on the canvas can use it. (A pinned note is a sticky with canvas context.)
Context chips: the small labels on a card showing what that node can see.
What this node sees: the reader panel section listing a node's context items and whether each was included.
Quick capture: pasting text, a link or an image straight onto the canvas.
Folder: a named group of canvases in the sidebar.

## Out of scope for v0.3 (goes to the README roadmap as v0.4)
Web search tool, model picker and answer style, connectors to external tools (MCP), audio and video files, OCR of scanned PDFs beyond what the model reads natively, sharing canvases with other people, canvas export, version history of files.

## Definition of done
All six units deployed and verified live by Gustav, no schema surprises, and no regressions in branching, path assembly, streaming, stickies, pinned context, collapse, minimap, Tidy, themes or gestures. In Unit 6's commit, update the README (features, how context works with the new scopes, API table, screenshots retaken on an invented demo canvas with invented files, roadmap v0.4), then rename this brief to __shipped after Gustav confirms.

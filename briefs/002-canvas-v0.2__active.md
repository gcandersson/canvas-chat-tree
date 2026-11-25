# Brief 002 — canvas-chat-tree v0.2

## Goal
Make the canvas feel as smooth as a modern AI chat app and turn it into a working surface: live streaming replies, readable long answers, colour-coded branches, sticky notes, collapse and a minimap, one-click tidy layout, and canvas-level instructions and pinned notes that the AI can use.

## Design rules for the whole brief
- Keep the current fresh dark look. New UI should feel like it was always part of it: same card style, same buttons, same spacing.
- Progress feedback is mandatory everywhere (CLAUDE.md UX rule).
- All schema changes are additive and idempotent (CREATE TABLE IF NOT EXISTS / ALTER TABLE ADD COLUMN IF NOT EXISTS). Never drop or rename anything.
- Never put real personal data in the repo, screenshots or test fixtures. Invented content only.

## Known pitfalls to design around from the start
1. Pointer handling. A canvas-level pointer capture used for panning must never swallow clicks on buttons, inputs, textareas, links or the reply scroll area inside cards and stickies. Only start a pan or drag after the pointer moves more than 5px; a press that moves less is a click. Interactive elements inside cards stop propagation.
2. Collapse scope. Collapsing a node hides that node's descendants only. It must never hide the node itself, its siblings, its ancestors, or the parent's other children. Test this explicitly with a node that has three children where only one is collapsed.
3. Positions vs auto layout. Node positions are always stored. Tidy layout is a one-off action that rewrites stored positions; it is never a live mode that ignores stored positions.
4. Prompt caching. Put the stable context (system prompt, canvas instructions, pinned notes) in the system blocks with cache_control on the last stable block, before the conversation messages. Do not put anything that changes per request (timestamps, counters) inside the cached part.
5. Streaming and reload. A reload or a second tab during streaming must not lose the reply or leave a card spinning forever.

## Units

### Unit 1 — Streaming replies
- New endpoint GET /api/nodes/:id/stream (Server-Sent Events, same Basic Auth). When a node is created or retried, the server streams the AI's text deltas to any connected stream clients and saves the growing reply to the database at most once per second, then the final reply with status done.
- The card shows text appearing word by word with markdown rendering, plus a small "Writing…" indicator and elapsed seconds until done.
- If the stream connection fails or the page reloads mid-reply, the client falls back to the existing polling and shows the partial reply saved so far, then the final one.
- Errors during streaming end in the existing error state with Retry.
Verify: ask for a long answer; text starts appearing within a few seconds and fills in live; reload mid-answer and it continues (partial text visible, then completes); Network tab shows the event stream.

### Unit 2 — Readable long replies
- Each card gets an "Expand" button. It opens a reader panel on the right side of the screen (overlay, canvas stays visible behind) showing the full prompt and full reply with markdown, a Copy button (copies the reply as markdown), and Continue / Branch buttons that work exactly like the card's.
- Esc or a close button closes it. The panel scrolls on its own.
- Cards keep their current size; the in-card scroll stays.
Verify: expand a long reply, read it fully, copy it and paste into a text editor, continue from the panel and see the new node appear on the canvas.

### Unit 3 — Branch colours and active path
- Each branch gets an accent colour from a fixed palette of 8 muted colours that read well on the dark theme (defined as CSS variables). A child that is the first child of its parent inherits the parent's colour; second and later children (branches) take the next palette colour in creation order under that parent.
- Card border and the edge leading into the card use the accent colour.
- Selecting a card (single click on its header) highlights the active path: that card and all its ancestors back to the root get a bright highlight border and bright edges; everything else stays as is. Click empty canvas to clear.
- Pure render logic, no storage.
Verify: a node with three children shows three distinct colour families; clicking a deep node lights up exactly its path to the root.

### Unit 4 — Sticky notes
- New table stickies: id uuid pk, canvas_id uuid fk on delete cascade, node_id uuid null fk nodes on delete set null (null = free-floating), x real, y real, color text default 'yellow', content text default '', in_context boolean default false, created_at, updated_at.
- API: GET stickies with the canvas payload; POST /api/canvases/:id/stickies; PATCH /api/stickies/:id (content, color, x, y, node_id, in_context); DELETE /api/stickies/:id.
- "+ Sticky" in the top bar places a free sticky at the centre of the viewport. A small sticky icon on each card creates a sticky attached to that card.
- Attached stickies sit next to their card with a short dashed connector and move with the card when it is dragged. Free stickies stay where they are put.
- Double-click to edit (plain textarea, plain text), drag to move, a row of 5 colour dots (yellow, green, blue, pink, purple, all muted for the dark theme), delete with a small confirm inside the sticky (no browser dialogs).
- Saving shows a quiet saved / saving / failed-with-retry state.
- In this unit stickies are never sent to the AI (in_context is stored but unused until Unit 7).
Verify: create a free and an attached sticky, edit, recolour, drag both, drag the attached card and see its sticky follow, reload and everything persists, delete one.

### Unit 5 — Collapse and minimap
- A card with children shows a small collapse toggle with the number of descendants. Collapsing hides that card's descendants and their edges and stickies attached to them, and shows a "+12" style badge on the card. Collapse state is stored per canvas in the browser (localStorage), not the database.
- Minimap: small overlay in the bottom-right corner showing all cards as small blocks (in their branch colours) and the current viewport as a rectangle. Click or drag in the minimap to move the view. Hidden on screens narrower than 700px.
Verify: the collapse-scope test from pitfall 2 passes; collapse survives reload; minimap rectangle tracks pan and zoom; clicking the minimap jumps the view.

### Unit 5b — Trackpad gestures like Miro (added after Unit 5 at Gustav's request)
- Two-finger scroll pans the canvas in any direction.
- Pinch zooms toward the cursor, and so does Ctrl or Cmd + scroll wheel.
- A plain mouse wheel without a modifier also pans vertically, with Shift + wheel panning horizontally.
- Scrolling inside a long reply, the reader panel or a sticky still scrolls that content, not the canvas.
Verify: two-finger scroll moves the canvas in all directions; pinch and Ctrl/Cmd + wheel zoom toward the cursor; a plain wheel pans up and down and Shift + wheel pans sideways; scrolling over a long reply, the reader panel or a long sticky scrolls that content.

### Unit 5c — Light mode (added after Unit 5 at Gustav's request)
- A theme toggle (sun/moon icon) in the top bar.
- Light theme: clean, neutral light grey canvas (around #F2F2F2) with a subtle square grid, white top bar, buttons, panels and cards, near-black text, bright pastel stickies and a clear blue primary highlight (around #4262FF), with the same layout and spacing. No warm or beige tones. (First built as warm off-white; changed to this neutral, Miro-style look at Gustav's request after Unit 6.)
- Every colour is a CSS variable with a dark and a light value, including a light-mode version of the 8-colour branch palette and the 5 sticky colours, so they read well on a light background.
- Default to the operating system's setting, remember the choice in localStorage, and switch instantly without a reload.
- All later units must support both themes.
Verify: the toggle switches the whole page at once with no reload; the choice survives a reload; with no stored choice the page follows the operating system; branch colours, stickies, the reader panel, the composer and the minimap all read well in both themes.

### Unit 6 — Tidy layout
- A "Tidy" button in the top bar computes a clean tree layout for the current canvas (each root's tree laid out top-down, children spread horizontally without overlap, separate trees side by side) and animates cards to their new positions, then saves all positions in one batch request (new endpoint PATCH /api/canvases/:id/positions).
- An "Undo tidy" toast appears for 10 seconds and restores the previous positions if clicked.
- Free stickies are left where they are; attached stickies follow their cards.
Verify: mess up a canvas by dragging, click Tidy, cards animate into a neat tree, reload keeps it; click Undo within 10 seconds and the old layout returns.

### Unit 7 — Canvas instructions and pinned notes as AI context
- New column canvases.instructions text null.
- A "Context" button in the top bar opens a side panel with: an Instructions text area for this canvas (saved with clear saving state), and a list of pinned notes (stickies with in_context true) showing their first line.
- Each sticky gets a small pin toggle "Use as AI context". Pinned stickies show a pin icon.
- Context assembly for every AI call on the canvas, in this order: base system prompt, then canvas instructions, then pinned notes (newest first, total pinned-note text capped at 8,000 characters; if the cap is hit the panel shows a visible warning listing which notes were left out), then the node's path as today. Follow pitfall 4 for caching.
- Unpinned stickies are never sent to the AI.
Verify: set instructions "Always answer in exactly three bullet points" and see new replies follow it; pin a sticky containing an invented fact (for example "The project code name is BLUE HERON") and ask "What is the project code name?" in a new node; unpin it and ask again in a new branch and it no longer knows; a different canvas is unaffected.

## New ubiquitous language
Streaming: the reply appearing word by word while the AI writes it.
Reader panel: the side panel that shows one node's full prompt and reply.
Accent colour: the colour of a branch family, used on card borders and edges.
Active path: the selected node plus all its ancestors to the root, highlighted.
Sticky: a human note on the canvas, free-floating or attached to a node.
Attached sticky: a sticky linked to a node that moves with it.
Pinned note: a sticky marked "Use as AI context"; sent to the AI for every node on that canvas.
Canvas instructions: free text set per canvas and sent to the AI for every node on that canvas.
Collapse: hiding a node's descendants on screen, per canvas, in the browser only.
Minimap: the small overview of the whole canvas in the bottom-right corner.
Tidy layout: a one-off action that rearranges all cards into a clean tree and saves the positions.
Pan: moving the viewport across the canvas without changing the zoom level.
Theme: the page's colour scheme, dark or light; follows the operating system until chosen, then remembered in the browser.

## Out of scope for v0.2 (goes to the README roadmap as v0.3)
File and image uploads, web search, model picker and answer style (prose / concise), dictation, connectors to my own tools (MCP), importing ChatGPT history, projects that group several canvases, canvas export, multi-user.

## Definition of done
All units (1 to 7, including 5b and 5c) deployed and verified live by Gustav, no schema surprises, no regressions in branching, path assembly, drag, markdown or error and retry. Update the README (features, screenshots retaken on an invented demo canvas, roadmap) in Unit 7's commit, then rename this brief to __shipped.

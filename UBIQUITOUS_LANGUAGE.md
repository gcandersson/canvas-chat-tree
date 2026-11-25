# Ubiquitous language — canvas-chat-tree

Canvas: one infinite, pannable, zoomable workspace. A user can have several canvases.
Node: one exchange on the canvas: a prompt written by the user plus the AI's reply. Shown as a card.
Root node: a node with no parent. It starts a new conversation on the canvas.
Child node: a node created from another node. Its parent is the node it was created from.
Branch: creating a second (or further) child from the same node, so the conversation splits in two directions. Any node can be branched at any time.
Path: the chain of nodes from a root node down to a given node. The AI sees only the path when it answers, never sibling branches.
Edge: the line drawn from a parent node to its child node.
Viewport: the part of the canvas currently visible on screen, defined by pan offset and zoom level.
Composer: the input box used to write a new prompt, opened from a node (to create a child) or from the canvas (to create a root node).
Node status: pending (waiting for the AI), done (reply received), error (the AI call failed; can be retried).
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

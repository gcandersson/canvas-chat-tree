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

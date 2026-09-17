# Whiteboards

A whiteboard is a durable, worktree-scoped Excalidraw scene. Use one for architecture,
topology, sequence, dependency, and process-flow diagrams that a user or agent may revise.
When a scratchpad needs a spatial diagram, prefer a whiteboard embed over Mermaid unless the
user explicitly needs text-only diagram source or rendering outside Pragma.

## CLI Workflow

Run from a Pragma terminal so `PRAGMA_WORKTREE_ID` selects the current worktree. Pass
`--worktree <id>` explicitly when operating elsewhere.

```sh
pragma-cli --json whiteboard create --title "Request flow" scene.excalidraw
pragma-cli --json whiteboard list
pragma-cli --json whiteboard search "gateway"
pragma-cli --json whiteboard get <id>
pragma-cli whiteboard view <id> /tmp/request-flow.png
pragma-cli --json whiteboard edit <id> --title "Request flow v2" scene-v2.excalidraw
```

`create` and `edit` accept `-` instead of a filename to read JSON from stdin. `edit` reads
the current board first and supplies its version automatically, but concurrent edits can still
conflict; re-read, reconcile, and retry rather than overwriting another writer. Do not delete a
board that a scratchpad embeds.

## Scene Contract

The top-level object requires all five fields below:

| Field      | Requirement                                                        |
| ---------- | ------------------------------------------------------------------ |
| `type`     | Exactly `"excalidraw"`.                                            |
| `version`  | Integer at least 1; use 2 for authored scenes.                     |
| `elements` | Array; every element requires string `id` and `type`.              |
| `appState` | Object; set `viewBackgroundColor` for predictable rendering.       |
| `files`    | Object keyed by binary-file id; use `{}` when there are no images. |

Use stable, unique element ids. Coordinates are canvas pixels. Linear elements store points
relative to their own `x`/`y`. Every visible element should include the standard Excalidraw
fields shown below; minimal `{ id, type }` objects pass storage validation but may not render or
remain editable in Excalidraw. Preserve unknown fields from `whiteboard get` when revising a
scene because Excalidraw evolves independently of this contract.

## Complete Example

This scene renders two labeled services connected by an arrow. It is intentionally verbose so
agents can copy it as a known-good base and change ids, labels, positions, and colors.

```json
{
  "type": "excalidraw",
  "version": 2,
  "source": "pragma",
  "elements": [
    {
      "id": "client-box",
      "type": "rectangle",
      "x": 40,
      "y": 80,
      "width": 180,
      "height": 90,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#a5d8ff",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": { "type": 3 },
      "seed": 101,
      "version": 1,
      "versionNonce": 1001,
      "isDeleted": false,
      "boundElements": [],
      "updated": 1,
      "link": null,
      "locked": false
    },
    {
      "id": "client-label",
      "type": "text",
      "x": 92,
      "y": 112,
      "width": 76,
      "height": 25,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 102,
      "version": 1,
      "versionNonce": 1002,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "fontSize": 20,
      "fontFamily": 5,
      "text": "Client",
      "textAlign": "center",
      "verticalAlign": "middle",
      "containerId": null,
      "originalText": "Client",
      "autoResize": true,
      "lineHeight": 1.25
    },
    {
      "id": "gateway-box",
      "type": "rectangle",
      "x": 360,
      "y": 80,
      "width": 180,
      "height": 90,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "#b2f2bb",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": { "type": 3 },
      "seed": 103,
      "version": 1,
      "versionNonce": 1003,
      "isDeleted": false,
      "boundElements": [],
      "updated": 1,
      "link": null,
      "locked": false
    },
    {
      "id": "gateway-label",
      "type": "text",
      "x": 405,
      "y": 112,
      "width": 90,
      "height": 25,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 1,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": null,
      "seed": 104,
      "version": 1,
      "versionNonce": 1004,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "fontSize": 20,
      "fontFamily": 5,
      "text": "Gateway",
      "textAlign": "center",
      "verticalAlign": "middle",
      "containerId": null,
      "originalText": "Gateway",
      "autoResize": true,
      "lineHeight": 1.25
    },
    {
      "id": "request-arrow",
      "type": "arrow",
      "x": 220,
      "y": 125,
      "width": 140,
      "height": 0,
      "angle": 0,
      "strokeColor": "#1e1e1e",
      "backgroundColor": "transparent",
      "fillStyle": "solid",
      "strokeWidth": 2,
      "strokeStyle": "solid",
      "roughness": 1,
      "opacity": 100,
      "groupIds": [],
      "frameId": null,
      "roundness": { "type": 2 },
      "seed": 105,
      "version": 1,
      "versionNonce": 1005,
      "isDeleted": false,
      "boundElements": null,
      "updated": 1,
      "link": null,
      "locked": false,
      "points": [
        [0, 0],
        [140, 0]
      ],
      "lastCommittedPoint": null,
      "startBinding": null,
      "endBinding": null,
      "startArrowhead": null,
      "endArrowhead": "arrow",
      "elbowed": false
    }
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff"
  },
  "files": {}
}
```

Use ordinary Excalidraw palette values for scene content: those colors belong to the
diagram itself. Pragma themes the editor chrome, not the persisted drawing.

## Embed In A Scratchpad

Create the board first and copy its returned id into MDX:

```mdx
import { Whiteboard } from "@pragma/scratchpad/ui";

# Request flow

The client sends authenticated requests through the gateway.

<Whiteboard id="whiteboard-id-from-create" />
```

Then create the managed scratchpad through the CLI:

```sh
pragma-cli scratchpad create --title "Request flow" request-flow.mdx
```

The embed is a live PNG view and polls for board-version changes. Its render follows the
scratchpad's light/dark mode. In desktop Pragma, clicking the diagram or **Open** launches the
same board in its interactive Excalidraw tab; editing still happens there rather than inside the
scratchpad frame. The board and scratchpad must belong to the same worktree. Never write
directly into `.pragma/scratchpads/`, paste scene JSON into MDX, or replace the component with a
stale PNG.

## Verify Agent-Authored Boards

An end-to-end CLI test should prove all of the following:

1. `create --json` returns a durable board id and version.
2. `list`, `search`, and `get` find that same id; search matches a text element.
3. `view` writes a non-empty PNG.
4. `edit` preserves the full scene and increments the board version.
5. A CLI-created scratchpad embeds the id with `<Whiteboard id="..." />`.
6. Temporary source JSON and rendered PNG are removed after verification; the durable board and scratchpad remain for user review.

Report the whiteboard id, final version/title, scratchpad path, and any failed command. Do not
claim visual success from command exit alone: inspect the rendered PNG when image-reading tools
are available, otherwise report that PNG generation was verified but visual appearance was not.

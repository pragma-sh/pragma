import { getBridge } from "./bridge";
import type { PragmaIconsBridge } from "./bridge";

/**
 * Host-rendered lucide icon components. Phase 1 only exposes the live bridge
 * object as a default export — Phase 2 adds named exports per icon (e.g.
 * `import { FolderIcon } from "@pragma/plugin/icons"`) once the icon set
 * plugins draw from is finalized.
 */
const icons: PragmaIconsBridge = getBridge().icons;

export default icons;

import { getBridge } from "./bridge";
import type { PragmaButtonProps, PragmaKbdProps, PragmaUiBridge } from "./bridge";

/**
 * Host-rendered UI primitives. These are runtime delegates onto the host bridge,
 * so plugin bundles never include the host component implementations.
 */
const ui: PragmaUiBridge = getBridge().ui;

export const Button: React.ComponentType<PragmaButtonProps> = ui.Button;
export const Kbd: React.ComponentType<PragmaKbdProps> = ui.Kbd;

export default ui;

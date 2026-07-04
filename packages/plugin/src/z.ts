import { getBridge } from "./bridge";
import type { z as ZodNamespace } from "zod";

/**
 * The zod v4 namespace, delegated to the host's own zod instance at runtime
 * via the Pragma bridge so plugin bundles never bundle zod themselves. Typed
 * against real zod so `z.object(...)`, `z.infer<...>`, etc. work exactly as
 * they would with a direct zod import.
 */
export const z: typeof ZodNamespace = getBridge().zod;

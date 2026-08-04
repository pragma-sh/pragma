export * from "@pragma/sdk";

/** Status rendered by scratchpad progress components. */
export type ScratchpadAgentStatus = "running" | "attention" | "done" | "cleared";

/** One attached or explicitly tracked agent tab. */
export interface ScratchpadAgentProgress {
  tabId: string;
  title?: string;
  agent?: string;
  status: ScratchpadAgentStatus;
}

/** Host bridge installed only inside a rendered Pragma scratchpad. */
export interface ScratchpadBridge {
  promptAgent(text: string): Promise<"sent" | "missing-agent">;
  requestAgentAttachment(): Promise<boolean>;
  subscribeAgentProgress(
    tabIds: readonly string[],
    listener: (progress: readonly ScratchpadAgentProgress[]) => void,
  ): () => void;
}

/** Context passed when a scratchpad action has no attached agent tab. */
export interface MissingAgentContext {
  text: string;
  attach(): Promise<boolean>;
}

/** Options for {@link promptAgent}. */
export interface PromptAgentOptions {
  onMissingAgent?: (context: MissingAgentContext) => void | boolean | Promise<void | boolean>;
}

declare global {
  var pragmaScratchpad: ScratchpadBridge | undefined;
}

function bridge(): ScratchpadBridge {
  const value = globalThis.pragmaScratchpad;
  if (!value) {
    throw new Error("@pragma/scratchpad can only prompt agents inside a Pragma scratchpad");
  }
  return value;
}

/** Returns scratchpad host bridge for UI bindings. */
export function scratchpadBridge(): ScratchpadBridge {
  return bridge();
}

/**
 * Sends text to attached agent tab. Missing attachment opens host picker by default;
 * `onMissingAgent` can replace that behavior for one call. Returns false when
 * user cancels attachment without sending.
 */
export async function promptAgent(
  text: string,
  options: PromptAgentOptions = {},
): Promise<boolean> {
  const value = text.trim();
  if (!value) return false;
  const host = bridge();
  if ((await host.promptAgent(value)) === "sent") return true;

  const attach = () => host.requestAgentAttachment();
  const customResult = await options.onMissingAgent?.({ text: value, attach });
  const attached = options.onMissingAgent ? customResult === true : await attach();
  if (!attached) return false;
  if (attached && (await host.promptAgent(value)) !== "sent") {
    throw new Error("Selected agent tab is no longer available");
  }
  return true;
}

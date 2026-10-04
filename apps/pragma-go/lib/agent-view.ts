/** Which surface of one agent session is on screen. */
export type AgentView = "chat" | "terminal";

/**
 * Narrows a tab value back to a known surface.
 *
 * The tabs primitive hands back a plain string, so an unrecognised value lands
 * on the transcript rather than attaching a terminal by accident.
 */
export function toAgentView(value: string): AgentView {
  return value === "terminal" ? "terminal" : "chat";
}

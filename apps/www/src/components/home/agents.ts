/** One supported agent integration, as shipped by a `packages/*-plugin` package. */
export interface AgentBrand {
  /** Plugin agent id (matches the Pragma plugin catalog). */
  id: string;
  /** Display name used in copy and alt text. */
  name: string;
  /** Public path of the official mark copied from the plugin's `assets/`. */
  logo: string;
  /** Rim/glow colour of the 3D chip; taken from the brand mark. */
  tint: string;
}

/**
 * The agent integrations Pragma ships out of the box. Keep in sync with the
 * `packages/*-plugin` workspaces (their marks live in `public/agents/`).
 */
export const AGENT_BRANDS: readonly AgentBrand[] = [
  { id: "claude-code", name: "Claude Code", logo: "/agents/claude-code.svg", tint: "#d97757" },
  { id: "codex", name: "Codex", logo: "/agents/codex.png", tint: "#6366f1" },
  { id: "opencode", name: "opencode", logo: "/agents/opencode.svg", tint: "#f1ecec" },
  { id: "cursor", name: "Cursor", logo: "/agents/cursor.svg", tint: "#e5e5e5" },
  { id: "grok", name: "Grok", logo: "/agents/grok.svg", tint: "#fcfcfc" },
  { id: "kimi", name: "Kimi Code", logo: "/agents/kimi.png", tint: "#5865f2" },
  {
    id: "github-copilot-cli",
    name: "GitHub Copilot CLI",
    logo: "/agents/copilot.png",
    tint: "#7c7cff",
  },
  { id: "pi", name: "Pi", logo: "/agents/pi-badge.svg", tint: "#a1a1aa" },
  { id: "prime-agent", name: "Prime Agent", logo: "/agents/prime-butterfly.svg", tint: "#c4b5fd" },
  { id: "junie", name: "Junie", logo: "/agents/junie.svg", tint: "#48e054" },
];

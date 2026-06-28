import { Bot } from "lucide-react";

import { useIconNeedsInvert } from "@/lib/icon-contrast";
import { type AgentConfig } from "@/lib/tauri";
import { cn } from "@/lib/utils";

/** Renders an agent's bundled icon, falling back to a generic bot glyph. */
export function AgentIcon({ agent, className }: { agent: AgentConfig; className?: string }) {
  const needsInvert = useIconNeedsInvert(agent.iconDataUrl);
  return agent.iconDataUrl ? (
    <img
      alt=""
      className={cn("size-4 rounded-sm", needsInvert && "invert", className)}
      src={agent.iconDataUrl}
    />
  ) : (
    <Bot className={cn("size-4 text-skill", className)} />
  );
}

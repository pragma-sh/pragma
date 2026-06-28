import type { AgentStatus } from "@pragma/constants";

import { cn } from "@/lib/utils";

interface AgentStatusDotProps {
  status: AgentStatus | null;
  className?: string;
}

/** Small aggregate status indicator for agent runtime state. */
export function AgentStatusDot({ status, className }: AgentStatusDotProps) {
  if (!status || status === "cleared") {
    return null;
  }
  return (
    <span
      className={cn(
        "inline-block size-2 shrink-0 rounded-full ring-1 ring-black/30",
        status === "done" && "bg-success shadow-[0_0_6px_var(--color-success)]",
        status === "attention" &&
          "animate-agent-attention bg-warning shadow-[0_0_8px_var(--color-warning)]",
        status === "running" &&
          "animate-agent-running bg-primary shadow-[0_0_6px_var(--color-primary)]",
        className,
      )}
      title={`Agent ${status}`}
    />
  );
}

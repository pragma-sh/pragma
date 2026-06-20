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
        status === "done" && "bg-green-500 shadow-[0_0_6px_#22c55e]",
        status === "attention" && "animate-agent-attention bg-red-500 shadow-[0_0_8px_#ef4444]",
        status === "running" && "animate-agent-running bg-yellow-400 shadow-[0_0_6px_#facc15]",
        className,
      )}
      title={`Agent ${status}`}
    />
  );
}

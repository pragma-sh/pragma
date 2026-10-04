import { motion } from "motion/react";

import type { AgentStatus } from "@pragma-sh/constants";

import { AGENT_STATUS_FILL } from "@/lib/agent-status-style";
import { motionTransition } from "@/lib/motion";
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
    // Pops in when an agent starts reporting, so status arriving in a quiet tab
    // strip catches the eye. The pulse itself stays in CSS (`index.css`).
    <motion.span
      animate={{ scale: 1, opacity: 1 }}
      initial={{ scale: 0, opacity: 0 }}
      transition={motionTransition.pop}
      className={cn(
        "inline-block size-2 shrink-0 rounded-full ring-1 ring-black/30",
        AGENT_STATUS_FILL[status],
        status === "done" && "shadow-[0_0_6px_var(--color-success)]",
        status === "attention" &&
          "animate-agent-attention shadow-[0_0_8px_var(--color-destructive)]",
        status === "running" && "animate-agent-running shadow-[0_0_6px_var(--color-warning)]",
        className,
      )}
      title={`Agent ${status}`}
    />
  );
}

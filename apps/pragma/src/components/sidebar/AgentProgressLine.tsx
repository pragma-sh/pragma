import { motion } from "motion/react";

import { AgentStatusDot } from "@/components/AgentStatusDot";
import {
  AGENT_STATUS_FILL,
  AGENT_STATUS_LABEL,
  type VisibleAgentStatus,
} from "@/lib/agent-status-style";
import { motionTransition } from "@/lib/motion";
import { cn } from "@/lib/utils";
import { agentActivityLabel, useAgentProgress } from "@/state/agent-progress-store";

/**
 * The bar never reads empty: an agent with no estimate yet (or no System 1
 * model to estimate it) still shows it has started.
 */
const MIN_PROGRESS = 0.1;

/** What one agent is doing, as text, and how far along it is (0..1, at least {@link MIN_PROGRESS}). */
function describe(
  status: VisibleAgentStatus,
  estimate: ReturnType<typeof useAgentProgress>,
): { label: string; progress: number } {
  const progress = Math.max(MIN_PROGRESS, estimate?.progress ?? 0);
  if (status === "done") return { label: AGENT_STATUS_LABEL.done, progress: 1 };
  if (status === "attention") return { label: AGENT_STATUS_LABEL.attention, progress };
  if (!estimate) return { label: AGENT_STATUS_LABEL.running, progress };
  return { label: agentActivityLabel(estimate.activity), progress };
}

/**
 * A thin estimated-progress bar, filled in the agent's status color. Animates
 * `scaleX` rather than `width` so reduced motion is honoured by `MotionConfig`.
 */
function ProgressBar({ status, progress }: { status: VisibleAgentStatus; progress: number }) {
  const percent = Math.round(progress * 100);
  return (
    <div className="relative h-1 w-full min-w-8 overflow-hidden rounded-full bg-muted">
      {/* The native element carries the value for assistive tech; the painted
          bar is decorative so it can animate a transform. */}
      <progress aria-label="Estimated progress" className="sr-only" max={100} value={percent}>
        {percent}%
      </progress>
      <motion.div
        aria-hidden
        animate={{ scaleX: progress }}
        className={cn("h-full w-full origin-left rounded-full", AGENT_STATUS_FILL[status])}
        initial={false}
        transition={motionTransition.base}
      />
    </div>
  );
}

/**
 * One agent's status line: the status dot, a word for what it is doing, and an
 * estimated progress bar.
 *
 * Without System 1 the word is the plain status (Running, Needs input,
 * Finished) and the bar holds at its floor until the agent finishes. With it,
 * a running agent shows the activity System 1 picked (Exploring, Coding,
 * Verifying, …) and the bar follows its estimate.
 */
export function AgentProgressLine({
  worktreeId,
  tabId,
  agent,
  status,
  className,
}: {
  worktreeId: string;
  tabId: string;
  agent: string;
  status: VisibleAgentStatus;
  className?: string;
}) {
  const estimate = useAgentProgress(worktreeId, tabId, agent);
  const { label, progress } = describe(status, estimate);
  return (
    <span className={cn("flex min-w-0 items-center gap-1.5 text-xs", className)}>
      <AgentStatusDot status={status} />
      <span className="shrink-0 text-muted-foreground">{label}</span>
      <ProgressBar progress={progress} status={status} />
    </span>
  );
}

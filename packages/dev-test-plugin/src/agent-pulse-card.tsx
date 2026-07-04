import type { AgentReportPayload } from "@pragma/constants";
import { useEffect, useState } from "react";

import { useEvent, useProject, useSdk } from "@pragma/plugin";

/** Snapshot of a single agent's live status, surfaced by the SDK event stream. */
interface AgentPulseEntry {
  agent: string;
  status: string;
}

const EMPTY_PULSE: AgentPulseEntry = { agent: "none", status: "idle" };

/**
 * Sidebar card that hooks the SDK's `agentStatus` event stream to show the
 * latest reported agent status, using `useSdk` and `useEvent`.
 */
export function AgentPulseCard() {
  const project = useProject();
  const sdk = useSdk();
  const [pulse, setPulse] = useState<AgentPulseEntry>(EMPTY_PULSE);
  const [reportsSeen, setReportsSeen] = useState(0);

  useEvent<AgentReportPayload>("agent.report", () => {
    setReportsSeen((count) => count + 1);
  });

  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        for await (const event of sdk.events.subscribe("agentStatus", {
          signal: controller.signal,
        })) {
          const payload = event.payload as AgentPulseEntry | undefined;
          if (payload) {
            setPulse(payload);
          }
        }
      } catch {
        // Aborted or closed — leave the last pulse in place.
      }
    })();
    return () => controller.abort();
  }, [sdk]);

  return (
    <div style={{ padding: 12 }}>
      <h3>Agent Pulse</h3>
      <p>Project: {project?.name ?? "None"}</p>
      <p data-testid="agent-pulse">
        Agent: {pulse.agent} — {pulse.status}
      </p>
      <p data-testid="reports-seen">Reports seen: {reportsSeen}</p>
    </div>
  );
}

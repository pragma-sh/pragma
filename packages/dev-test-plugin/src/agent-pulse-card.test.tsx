import type { PragmaClient } from "@pragma/sdk";
import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentPulseCard } from "./agent-pulse-card";
import { createBridge, eventsFrom, setBridge, type TestSubscriptionEvent } from "./test/bridge";

describe("AgentPulseCard", () => {
  it("shows the idle placeholder before any SDK event arrives", () => {
    render(<AgentPulseCard />);

    expect(screen.getByTestId("agent-pulse")).toHaveTextContent("Agent: none — idle");
    expect(screen.getByTestId("reports-seen")).toHaveTextContent("Reports seen: 0");
  });

  it("updates the pulse from the SDK agentStatus event stream", async () => {
    const snapshot: TestSubscriptionEvent = {
      type: "snapshot",
      subscription: "agentStatus",
      payload: { agent: "claude", status: "running" },
    };
    const sdk = { events: { subscribe: () => eventsFrom(snapshot) } } as unknown as PragmaClient;
    setBridge(createBridge({ useSdk: () => sdk }));

    render(<AgentPulseCard />);

    await waitFor(() => {
      expect(screen.getByTestId("agent-pulse")).toHaveTextContent("Agent: claude — running");
    });
    expect(screen.getByTestId("reports-seen")).toHaveTextContent("Reports seen: 0");
  });

  it("counts host agent.report events via useEvent", async () => {
    const handle = createBridge();
    setBridge(handle);

    render(<AgentPulseCard />);
    handle.emit("agent.report", {
      agent: "opencode",
      worktreeId: "w",
      tabId: "t",
      status: "attention",
    });

    await waitFor(() => {
      expect(screen.getByTestId("reports-seen")).toHaveTextContent("Reports seen: 1");
    });
  });
});

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/components/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: { id: string } }) => (
    <span data-testid={`agent-icon-${agent.id}`} />
  ),
}));

vi.mock("@/hooks/use-agents-list", () => ({
  useAgentsList: () => [
    { id: "opencode", name: "OpenCode", iconDataUrl: null, start: ["opencode"] },
  ],
}));

vi.mock("@/lib/native-overlay", () => ({
  useSuppressNativeOverlayWhile: vi.fn(),
}));

vi.mock("@/state/agent-pins", () => ({
  isAgentPinned: () => false,
  toggleAgentPin: vi.fn(),
  useAgentPins: () => new Set<string>(),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({
    createTerminalTab: vi.fn(),
    selectedWorktree: { id: "main" },
  }),
}));

import { AgentsMenu } from "./AgentsMenu";

describe("AgentsMenu", () => {
  it("shows each agent icon in the open agent dropdown", async () => {
    const user = userEvent.setup();
    render(<AgentsMenu />);

    await user.click(screen.getByRole("button", { name: /open agent/i }));

    expect(screen.getByTestId("agent-icon-opencode")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /opencode/i })).toBeInTheDocument();
  });
});

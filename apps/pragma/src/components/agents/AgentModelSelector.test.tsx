import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentModel, AgentModelSelection } from "@/lib/tauri";

vi.mock("@/components/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: AgentConfig }) => <span data-testid={`agent-${agent.id}`} />,
}));

vi.mock("@/lib/native-overlay", () => ({
  useSuppressNativeOverlayWhile: vi.fn(),
}));

vi.mock("@/state/model-pins", () => ({
  isModelPinned: () => false,
  sortModelsByPin: (_agentId: string, models: AgentModel[]) => models,
  toggleModelPin: vi.fn(),
  useModelPins: () => new Set<string>(),
}));

import { AgentModelSelector } from "./AgentModelSelector";

const agents: AgentConfig[] = [
  {
    id: "opencode",
    name: "OpenCode",
    iconDataUrl: null,
    start: ["opencode"],
  },
  {
    id: "claude-code",
    name: "Claude Code",
    iconDataUrl: null,
    start: ["claude"],
  },
];

const modelsByAgent: Record<string, AgentModel[]> = {
  opencode: [
    { id: "gpt-5.6", name: "GPT 5.6", reasoning: [] },
    {
      id: "gpt-5.6-codex",
      name: "GPT 5.6 Codex",
      reasoning: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
  ],
  "claude-code": [{ id: "opus", name: "Claude Opus", reasoning: [] }],
};

function renderSelector(
  selection: AgentModelSelection = { modelId: "gpt-5.6", reasoningId: null },
  onChange = vi.fn(),
  onLoadModels = vi.fn(),
) {
  render(
    <AgentModelSelector
      agents={agents}
      modelsByAgent={modelsByAgent}
      value={{ agentId: "opencode", selection }}
      onChange={onChange}
      onLoadModels={onLoadModels}
    />,
  );
  return { onChange, onLoadModels };
}

function openRoot() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Agent" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

function openSubmenu(name: string | RegExp) {
  fireEvent.pointerMove(screen.getByRole("menuitem", { name }), { pointerType: "mouse" });
}

describe("AgentModelSelector", () => {
  it("searches models after hovering an agent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    const onLoadModels = vi.fn();
    renderSelector(undefined, onChange, onLoadModels);

    openRoot();
    openSubmenu(/OpenCode/);
    const search = await screen.findByRole("searchbox", { name: "Search models" });
    expect(onLoadModels).toHaveBeenCalledWith("opencode");

    await user.type(search, "codex");
    const modelMenu = screen
      .getByRole("searchbox", { name: "Search models" })
      .closest<HTMLElement>("[data-slot=dropdown-menu-sub-content]");
    if (!modelMenu) throw new Error("expected model submenu");

    expect(within(modelMenu).getByText("GPT 5.6 Codex")).toBeVisible();
    expect(within(modelMenu).queryByText("GPT 5.6", { exact: true })).not.toBeInTheDocument();

    await user.clear(search);
    fireEvent.click(within(modelMenu).getByText("GPT 5.6"));

    expect(onChange).toHaveBeenCalledWith("opencode", {
      modelId: "gpt-5.6",
      reasoningId: null,
    });
  });

  it("opens reasoning by hovering a model", async () => {
    const onChange = vi.fn();
    renderSelector({ modelId: "gpt-5.6-codex", reasoningId: null }, onChange);

    openRoot();
    openSubmenu(/OpenCode/);
    await screen.findByRole("searchbox", { name: "Search models" });
    openSubmenu(/GPT 5.6 Codex/);
    fireEvent.click(await screen.findByRole("menuitem", { name: "High" }));

    expect(onChange).toHaveBeenCalledWith("opencode", {
      modelId: "gpt-5.6-codex",
      reasoningId: "high",
    });
  });
});

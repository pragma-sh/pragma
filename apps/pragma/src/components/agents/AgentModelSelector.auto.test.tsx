import { useState } from "react";

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentModel, AgentModelSelection, AutoSelection } from "@/lib/tauri";

const system1 = vi.hoisted(() => ({ configured: true }));
const autoSelect = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());

vi.mock("@/components/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: AgentConfig }) => <span data-testid={`agent-${agent.id}`} />,
}));
vi.mock("@/lib/native-overlay", () => ({ useSuppressNativeOverlayWhile: vi.fn() }));
vi.mock("@/state/system1", () => ({
  useSystem1Status: () => ({
    configured: system1.configured,
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
  }),
}));
vi.mock("@/lib/tauri", () => ({ system1AutoSelect: autoSelect }));
vi.mock("sonner", () => ({ toast: { error: toastError } }));

import {
  autoSelectionToLaunch,
  buildAutoSelectInput,
  useAutoSubmit,
} from "@/hooks/use-auto-agent-selection";

import { AgentModelSelector } from "./AgentModelSelector";

const agents: AgentConfig[] = [
  { id: "claude-code", name: "Claude Code", iconDataUrl: null, start: ["claude"] },
  { id: "codex", name: "Codex", iconDataUrl: null, start: ["codex"] },
];

const modelsByAgent: Record<string, AgentModel[]> = {
  "claude-code": [
    {
      id: "opus",
      name: "Opus",
      canonicalId: "anthropic/claude-opus-5-5",
      reasoning: [
        { id: "low", name: "Low" },
        { id: "high", name: "High" },
      ],
    },
  ],
  codex: [{ id: "gpt-6-astra", name: "GPT-6 Astra", reasoning: [] }],
};

function selection(overrides: Partial<AutoSelection> = {}): AutoSelection {
  return {
    agentId: "claude-code",
    modelId: "opus",
    reasoningId: "high",
    confidence: 0.8,
    lowConfidence: false,
    difficulty: 0.75,
    agentProbabilities: { "claude-code": 0.8, codex: 0.2 },
    modelProbabilities: {},
    reason: "Claude Code 80% · Opus · hard task → High",
    warnings: [],
    sources: { modelBenchmarks: true, harnessBenchmarks: true, usageLimits: false },
    ...overrides,
  };
}

function openRoot() {
  fireEvent.pointerDown(screen.getByRole("button", { name: "Agent" }), {
    button: 0,
    ctrlKey: false,
    pointerType: "mouse",
  });
}

beforeEach(() => {
  system1.configured = true;
  window.localStorage.clear();
});

afterEach(() => {
  autoSelect.mockReset();
  toastError.mockReset();
});

/** A minimal launching dialog: a picker, and a submit that records what it launched. */
function Dialog({
  onLaunch,
}: {
  onLaunch: (agentId: string | null, s: AgentModelSelection) => void;
}) {
  const [agentId, setAgentId] = useState<string | null>("codex");
  const [picked, setPicked] = useState<AgentModelSelection>({
    modelId: "gpt-6-astra",
    reasoningId: null,
  });
  const auto = useAutoSubmit(() => onLaunch(agentId, picked));
  return (
    <>
      <AgentModelSelector
        agents={agents}
        modelsByAgent={modelsByAgent}
        value={{ agentId, selection: picked }}
        onChange={(id, next) => {
          setAgentId(id);
          setPicked(next);
        }}
        onLoadModels={vi.fn()}
        autoTarget={{ prompt: "Refactor the session layer", projectId: "p1" }}
        autoRegistry={auto.registry}
      />
      <button type="button" disabled={auto.resolving} onClick={() => void auto.submit()}>
        Launch
      </button>
      {auto.active ? <span>auto-active</span> : null}
    </>
  );
}

describe("auto-mode helpers", () => {
  it("builds the request from every agent, with an empty list for unloaded models", () => {
    const input = buildAutoSelectInput(
      { prompt: "fix CI", projectId: "p1", branch: "main" },
      agents,
      { "claude-code": modelsByAgent["claude-code"] },
    );
    expect(input).toEqual({
      projectId: "p1",
      prompt: "fix CI",
      context: { project: null, worktree: null, branch: "main" },
      agents: [
        { id: "claude-code", name: "Claude Code", models: modelsByAgent["claude-code"] },
        { id: "codex", name: "Codex", models: [] },
      ],
    });
  });

  it("re-validates the pick against the loaded models", () => {
    expect(autoSelectionToLaunch(selection(), modelsByAgent)).toEqual({
      agentId: "claude-code",
      selection: { modelId: "opus", reasoningId: "high" },
    });
    expect(autoSelectionToLaunch(selection({ modelId: "gone" }), modelsByAgent).selection).toEqual({
      modelId: null,
      reasoningId: null,
    });
  });
});

describe("AgentModelSelector auto mode", () => {
  it("shows only Auto and asks System 1 on submit, launching with its pick", async () => {
    autoSelect.mockResolvedValue(selection());
    const onLaunch = vi.fn();
    render(<Dialog onLaunch={onLaunch} />);
    openRoot();
    fireEvent.click(screen.getByRole("menuitem", { name: /Auto/ }));

    const trigger = screen.getByRole("button", { name: "Agent" });
    expect(trigger.textContent).toBe("Auto");
    expect(screen.getByText("auto-active")).toBeTruthy();
    expect(window.localStorage.getItem("pragma:agent-auto-mode")).toBe("on");
    // Nothing is asked before the user submits.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(autoSelect).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() =>
      expect(onLaunch).toHaveBeenCalledWith("claude-code", {
        modelId: "opus",
        reasoningId: "high",
      }),
    );
    expect(autoSelect).toHaveBeenCalledTimes(1);
    expect(autoSelect).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: "Refactor the session layer", projectId: "p1" }),
    );
    expect(trigger.textContent).toBe("Auto");
  });

  it("launches nothing and toasts when the pick fails", async () => {
    window.localStorage.setItem("pragma:agent-auto-mode", "on");
    autoSelect.mockRejectedValue("ai error: System 1 request failed (401): Check your key.");
    const onLaunch = vi.fn();
    render(<Dialog onLaunch={onLaunch} />);
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(String(toastError.mock.calls[0]?.[0])).toContain("Check your key");
    expect(onLaunch).not.toHaveBeenCalled();
  });

  it("launches the manual pick directly when not on Auto", async () => {
    const onLaunch = vi.fn();
    render(<Dialog onLaunch={onLaunch} />);
    expect(screen.queryByText("auto-active")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() =>
      expect(onLaunch).toHaveBeenCalledWith("codex", { modelId: "gpt-6-astra", reasoningId: null }),
    );
    expect(autoSelect).not.toHaveBeenCalled();
  });

  it("hides Auto for a picker with no launching dialog", () => {
    render(
      <AgentModelSelector
        agents={agents}
        modelsByAgent={modelsByAgent}
        value={{ agentId: "codex", selection: { modelId: null, reasoningId: null } }}
        onChange={vi.fn()}
        onLoadModels={vi.fn()}
      />,
    );
    openRoot();
    expect(screen.queryByRole("menuitem", { name: /Auto/ })).toBeNull();
  });

  it("disables Auto until a System 1 model is configured", () => {
    system1.configured = false;
    render(<Dialog onLaunch={vi.fn()} />);
    openRoot();
    const item = screen.getByRole("menuitem", { name: /Auto/ });
    expect(item.getAttribute("aria-disabled")).toBe("true");
    expect(item.textContent).toContain("Add a System 1 model in Settings");
  });

  it("leaves auto mode when the user picks a model", async () => {
    window.localStorage.setItem("pragma:agent-auto-mode", "on");
    const onLaunch = vi.fn();
    render(<Dialog onLaunch={onLaunch} />);
    openRoot();
    fireEvent.pointerMove(screen.getByRole("menuitem", { name: /Codex/ }), {
      pointerType: "mouse",
    });
    fireEvent.click(await screen.findByText("GPT-6 Astra"));
    expect(window.localStorage.getItem("pragma:agent-auto-mode")).toBe("off");
    expect(screen.getByRole("button", { name: "Agent" }).textContent).toContain("Codex");
    fireEvent.click(screen.getByRole("button", { name: "Launch" }));
    await waitFor(() => expect(onLaunch).toHaveBeenCalled());
    expect(autoSelect).not.toHaveBeenCalled();
  });
});

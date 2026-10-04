import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentConfig, AgentModel, AgentModelSelection } from "@/lib/tauri";

vi.mock("@/components/agents/AgentIcon", () => ({
  AgentIcon: ({ agent }: { agent: AgentConfig }) => <span data-testid={`agent-${agent.id}`} />,
}));

vi.mock("@/lib/native-overlay", () => ({
  useSuppressNativeOverlayWhile: vi.fn(),
}));

/**
 * A reactive stand-in for the real pin store: same composite-key shape, same
 * subscribe/notify contract, so a pin toggle actually re-renders and reorders
 * the model list the way it does in the app.
 */
/** Composite key the real store pins models under: JSON of [agentId, modelId]. */
const pinKey = (agentId: string, modelId: string) => JSON.stringify([agentId, modelId]);

const modelPins = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  let pins = new Set<string>();
  return {
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => pins,
    toggle(agentId: string, modelId: string) {
      pins = new Set(pins);
      const composite = pinKey(agentId, modelId);
      if (pins.has(composite)) {
        pins.delete(composite);
      } else {
        pins.add(composite);
      }
      for (const listener of listeners) listener();
    },
    reset: () => {
      pins = new Set();
    },
  };
});

vi.mock("@/state/model-pins", async () => {
  const { useSyncExternalStore } = await import("react");
  const emptyPins = new Set<string>();
  return {
    isModelPinned: (agentId: string, modelId: string) =>
      modelPins.snapshot().has(pinKey(agentId, modelId)),
    sortModelsByPin: <T extends { id: string }>(
      agentId: string,
      models: T[],
      pinned: Set<string>,
    ): T[] => {
      const top = models.filter((model) => pinned.has(pinKey(agentId, model.id)));
      const rest = models.filter((model) => !pinned.has(pinKey(agentId, model.id)));
      return [...top, ...rest];
    },
    toggleModelPin: (agentId: string, modelId: string) => modelPins.toggle(agentId, modelId),
    useModelPins: () =>
      useSyncExternalStore(modelPins.subscribe, modelPins.snapshot, () => emptyPins),
  };
});

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

/** A full pointer press, the way a real mouse press reaches Radix handlers. */
function pressPointer(element: Element) {
  fireEvent.pointerDown(element, { button: 0, pointerType: "mouse" });
  fireEvent.pointerUp(element, { button: 0, pointerType: "mouse" });
  fireEvent.click(element);
}

/** The model submenu currently open for an agent. */
function modelSubmenu() {
  const search = screen.getByRole("searchbox", { name: "Search models" });
  return search.closest<HTMLElement>("[data-slot=dropdown-menu-sub-content]");
}

afterEach(() => {
  modelPins.reset();
});

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

  /// Radix selects a menu item from pointer events — a `pointerup` whose
  /// `pointerdown` never reached the item is synthesized into a click. The pin
  /// button must stop the whole gesture so a pin click neither selects the
  /// model nor closes the menus.
  it("pins a plain model from the leaf row without selecting it or closing the menu", async () => {
    const onChange = vi.fn();
    renderSelector(undefined, onChange);

    openRoot();
    openSubmenu(/OpenCode/);
    await screen.findByRole("searchbox", { name: "Search models" });
    const pin = screen.getByRole("button", { name: "Pin GPT 5.6" });
    pressPointer(pin);

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Unpin GPT 5.6" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /OpenCode/ })).toBeInTheDocument();
  });

  /// The pin on a reasoning model sits inside the submenu trigger, so the same
  /// press also has to leave the trigger's click-toggle alone.
  it("pins a reasoning model from its submenu trigger row, keeping every menu open", async () => {
    const onChange = vi.fn();
    renderSelector(undefined, onChange);

    openRoot();
    openSubmenu(/OpenCode/);
    await screen.findByRole("searchbox", { name: "Search models" });
    openSubmenu(/GPT 5.6 Codex/);
    await screen.findByRole("menuitem", { name: "Low" });

    pressPointer(screen.getByRole("button", { name: "Pin GPT 5.6 Codex" }));

    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Unpin GPT 5.6 Codex" })).toBeInTheDocument();
    // The reasoning submenu and the agent submenu above it are both still open.
    expect(screen.getByRole("menuitem", { name: "Low" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search models" })).toBeInTheDocument();
  });

  it("reorders the pinned model to the top without closing the menu", async () => {
    const onChange = vi.fn();
    renderSelector(undefined, onChange);

    openRoot();
    openSubmenu(/OpenCode/);
    await screen.findByRole("searchbox", { name: "Search models" });

    const submenu = modelSubmenu();
    if (!submenu) throw new Error("expected model submenu");
    const leaf = within(submenu).getByText("GPT 5.6", { exact: true });
    const codex = within(submenu).getByText("GPT 5.6 Codex");
    expect(leaf.compareDocumentPosition(codex) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    pressPointer(screen.getByRole("button", { name: "Pin GPT 5.6 Codex" }));

    const reordered = modelSubmenu();
    if (!reordered) throw new Error("expected model submenu to stay open");
    expect(
      within(reordered)
        .getByText("GPT 5.6")
        .compareDocumentPosition(within(reordered).getByText("GPT 5.6 Codex")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeFalsy();
    expect(screen.getByRole("menuitem", { name: /OpenCode/ })).toBeInTheDocument();
    expect(onChange).not.toHaveBeenCalled();
  });

  /// The pin fix must not blunt the ordinary path: a plain click on a model
  /// still selects it and closes the whole selector.
  it("still selects a model and closes the menu from an ordinary click", async () => {
    const onChange = vi.fn();
    renderSelector(undefined, onChange);

    openRoot();
    openSubmenu(/OpenCode/);
    fireEvent.click(await screen.findByText("GPT 5.6", { exact: true }));

    expect(onChange).toHaveBeenCalledWith("opencode", {
      modelId: "gpt-5.6",
      reasoningId: null,
    });
    expect(screen.queryByRole("searchbox", { name: "Search models" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: /OpenCode/ })).not.toBeInTheDocument();
  });
});

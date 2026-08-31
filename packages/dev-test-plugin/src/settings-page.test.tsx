import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { PragmaClient } from "@pragma/sdk";

import { DevTestSettingsPage } from "./settings-page";
import { createBridge, setBridge } from "./test/bridge";

describe("DevTestSettingsPage", () => {
  it("creates a board draft with the selected worktree, agent, model, and reasoning", async () => {
    const createBoardDraft = vi.fn().mockResolvedValue({
      id: "card-1",
      branchName: "main",
    });
    const notify = vi.fn();
    setBridge(
      createBridge({
        useSdk: () => ({ createBoardDraft }) as unknown as PragmaClient,
        useNotify: () => notify,
      }),
    );

    render(<DevTestSettingsPage />);
    fireEvent.change(screen.getByLabelText("Worktree ID"), { target: { value: "wt-1" } });
    fireEvent.change(screen.getByLabelText("Model ID"), { target: { value: "gpt-5" } });
    fireEvent.change(screen.getByLabelText("Reasoning level"), { target: { value: "high" } });
    fireEvent.click(screen.getByRole("button", { name: "Create board draft" }));

    await waitFor(() =>
      expect(createBoardDraft).toHaveBeenCalledWith({
        prompt: "Create a small README improvement",
        worktreeId: "wt-1",
        agentId: "opencode",
        modelId: "gpt-5",
        reasoningId: "high",
      }),
    );
    expect(notify).toHaveBeenCalledWith("Board draft created", {
      variant: "success",
      description: "main: card-1",
    });
  });
});

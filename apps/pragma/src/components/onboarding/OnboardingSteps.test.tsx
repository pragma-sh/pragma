import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SkillsStep, ThemeStep } from "@/components/onboarding/OnboardingSteps";
import { THEME_OPTIONS } from "@/lib/theme-presets";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  Channel: class MockChannel<T> {
    onmessage?: (message: T) => void;
  },
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

vi.mock("@/state/theme-context", () => ({
  useTheme: () => ({ global: null, project: null, errors: {}, reload: () => undefined }),
}));

describe("SkillsStep", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve(["/home/dev/.claude/skills/pragma"]));
  });

  it("installs into one target per button, without ending the step", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(<SkillsStep onNext={onNext} />);

    await user.click(screen.getByRole("button", { name: /install in ~\/\.claude/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("install_pragma_skill", {
        targets: ["claude-code"],
      }),
    );
    expect(onNext).not.toHaveBeenCalled();
    expect(
      await screen.findByRole("button", { name: /installed in ~\/\.claude/i }),
    ).toBeInTheDocument();
  });

  it("installs into every target from the both button", async () => {
    const user = userEvent.setup();
    render(<SkillsStep onNext={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /^install in both$/i }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("install_pragma_skill", {
        targets: ["all-agents", "claude-code"],
      }),
    );
    expect(await screen.findByRole("button", { name: /installed in both/i })).toBeDisabled();
  });

  it("requires an install before continuing, but can be skipped", async () => {
    const user = userEvent.setup();
    const onNext = vi.fn();
    render(<SkillsStep onNext={onNext} />);

    expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled();

    await user.click(screen.getByRole("button", { name: /^skip$/i }));

    expect(onNext).toHaveBeenCalledOnce();
    expect(invokeMock).not.toHaveBeenCalledWith("install_pragma_skill", expect.anything());
  });

  it("enables the primary action once a target is installed", async () => {
    const user = userEvent.setup();
    render(<SkillsStep onNext={vi.fn()} />);

    await user.click(screen.getByRole("button", { name: /install in ~\/\.claude/i }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Continue" })).toBeEnabled());
  });
});

describe("ThemeStep", () => {
  afterEach(() => {
    cleanup();
  });

  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockImplementation(() => Promise.resolve(null));
  });

  it("writes the chosen palette to the global theme", async () => {
    const user = userEvent.setup();
    render(<ThemeStep onNext={vi.fn()} />);

    const [option] = THEME_OPTIONS;
    expect(option).toBeDefined();
    await user.click(screen.getByRole("button", { name: new RegExp(option!.name, "i") }));

    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith(
        "write_theme",
        expect.objectContaining({ scope: "global" }),
      ),
    );
  });
});

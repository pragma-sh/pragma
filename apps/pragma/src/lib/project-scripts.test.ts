import { beforeEach, describe, expect, it, vi } from "vitest";

const runProjectScripts = vi.fn();
const toastError = vi.fn();
const toastWarning = vi.fn();

vi.mock("@/lib/tauri", () => ({
  runProjectScripts: (...args: unknown[]) => runProjectScripts(...args),
}));
vi.mock("sonner", () => ({
  toast: {
    error: (...args: unknown[]) => toastError(...args),
    warning: (...args: unknown[]) => toastWarning(...args),
    success: vi.fn(),
  },
}));

import { runProjectRemoveScripts, scriptFailureSummary } from "@/lib/project-scripts";

const FAILURE = [
  "project.remove scripts failed:",
  "1. docker compose down exited 1",
  "",
  "Command: docker compose down",
  "Exit: 1",
  "--- stderr ---",
  "no such service",
].join("\n");

describe("scriptFailureSummary", () => {
  it("lists only the failed commands, not the header or each command's output", () => {
    expect(scriptFailureSummary(`script error: ${FAILURE}`)).toBe("docker compose down exited 1");
  });

  it("shortens a long command so the toast stays readable", () => {
    const long = `echo ${"x".repeat(200)}`;
    const summary = scriptFailureSummary(`h:\n1. ${long} exited 7\n\nCommand: ${long}`);

    expect(summary.endsWith("… exited 7")).toBe(true);
    expect(summary.length).toBeLessThan(80);
  });

  it("returns a message without command detail unchanged", () => {
    expect(scriptFailureSummary("project not found")).toBe("project not found");
  });
});

describe("runProjectRemoveScripts", () => {
  beforeEach(() => {
    runProjectScripts.mockReset();
    toastError.mockReset();
  });

  it("lets the removal go ahead when the scripts pass", async () => {
    runProjectScripts.mockResolvedValue(true);

    await expect(runProjectRemoveScripts("p", vi.fn())).resolves.toBe(true);
    expect(runProjectScripts).toHaveBeenCalledWith("p", "remove");
  });

  it("vetoes the removal and offers to remove anyway when they fail", async () => {
    runProjectScripts.mockRejectedValue(new Error(FAILURE));
    const removeAnyway = vi.fn();

    await expect(runProjectRemoveScripts("p", removeAnyway)).resolves.toBe(false);

    const [, options] = toastError.mock.calls[0] as [
      string,
      { action: { label: string; onClick: () => void }; duration: number },
    ];
    expect(options.action.label).toBe("Remove anyway");
    // A toast asking for a decision must not time out before it is made.
    expect(options.duration).toBe(Number.POSITIVE_INFINITY);
    options.action.onClick();
    expect(removeAnyway).toHaveBeenCalled();
  });
});

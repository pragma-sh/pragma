import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const setSystem1Status = vi.fn();
const system1Status = vi.fn();
const system1SetApiKey = vi.fn();
const system1ClearApiKey = vi.fn();
const system1Check = vi.fn();

vi.mock("@/state/system1", () => ({
  useSystem1Status: () => ({
    configured: true,
    baseUrl: "https://api.typesafe.ai",
    model: "jev-latest",
  }),
  setSystem1Status: (...args: unknown[]) => setSystem1Status(...args),
}));

vi.mock("@/lib/tauri", () => ({
  system1Check: (...args: unknown[]) => system1Check(...args),
  system1ClearApiKey: (...args: unknown[]) => system1ClearApiKey(...args),
  system1SetApiKey: (...args: unknown[]) => system1SetApiKey(...args),
  system1Status: (...args: unknown[]) => system1Status(...args),
}));

vi.mock("@/lib/open-external", () => ({ openExternal: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

import { System1ConnectionForm } from "./System1ConnectionForm";

describe("System1ConnectionForm", () => {
  beforeEach(() => {
    setSystem1Status.mockReset();
    system1Status.mockReset();
    system1SetApiKey.mockReset();
    system1ClearApiKey.mockReset();
    system1Check.mockReset();
  });

  it("refreshes the shared status after saving a URL without a new key", async () => {
    system1Status.mockResolvedValue({
      configured: true,
      baseUrl: "https://new.example",
      model: "m",
    });
    const saveSettings = vi.fn().mockResolvedValue(undefined);
    render(<System1ConnectionForm saveSettings={saveSettings} />);

    fireEvent.change(screen.getByLabelText("Base URL or endpoint"), {
      target: { value: "https://new.example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(saveSettings).toHaveBeenCalled());
    await waitFor(() => expect(system1Status).toHaveBeenCalled());
    expect(system1SetApiKey).not.toHaveBeenCalled();
    expect(setSystem1Status).toHaveBeenCalledWith({
      configured: true,
      baseUrl: "https://new.example",
      model: "m",
    });
  });
});

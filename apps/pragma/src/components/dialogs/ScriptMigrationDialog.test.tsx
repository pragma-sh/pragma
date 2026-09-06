import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ScriptMigrationOffer } from "@/lib/tauri";

const detectScriptMigrationMock = vi.fn();
const applyScriptMigrationMock = vi.fn();
const dismissScriptMigrationMock = vi.fn();
let selectedProjectId: string | null = "project-1";

vi.mock("@/lib/tauri", () => ({
  detectScriptMigration: (...args: unknown[]) => detectScriptMigrationMock(...args),
  applyScriptMigration: (...args: unknown[]) => applyScriptMigrationMock(...args),
  dismissScriptMigration: (...args: unknown[]) => dismissScriptMigrationMock(...args),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ selectedProjectId }),
}));

import { ScriptMigrationDialog } from "./ScriptMigrationDialog";

const OFFER: ScriptMigrationOffer = {
  sourceId: "superset",
  sourceLabel: "Superset",
  configPath: ".superset/config.json",
  setup: ["bun install"],
  run: ["bun dev"],
  teardown: [],
  preview: '{\n  "setup": [\n    "bun install"\n  ]\n}\n',
};

describe("ScriptMigrationDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    selectedProjectId = "project-1";
  });

  it("imports the detected config with the commit toggle on by default", async () => {
    detectScriptMigrationMock.mockResolvedValue(OFFER);
    applyScriptMigrationMock.mockResolvedValue(undefined);
    render(<ScriptMigrationDialog />);

    await screen.findByText("Import Superset scripts?");
    expect(screen.getByText("bun install")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Import scripts" }));

    await waitFor(() => expect(applyScriptMigrationMock).toHaveBeenCalledWith("project-1", true));
  });

  it("imports without a commit when the toggle is off", async () => {
    detectScriptMigrationMock.mockResolvedValue(OFFER);
    applyScriptMigrationMock.mockResolvedValue(undefined);
    render(<ScriptMigrationDialog />);

    await screen.findByText("Import Superset scripts?");
    fireEvent.click(screen.getByRole("switch"));
    fireEvent.click(screen.getByRole("button", { name: "Import scripts" }));

    await waitFor(() => expect(applyScriptMigrationMock).toHaveBeenCalledWith("project-1", false));
  });

  it("remembers a dismissal for the project", async () => {
    detectScriptMigrationMock.mockResolvedValue(OFFER);
    dismissScriptMigrationMock.mockResolvedValue(undefined);
    render(<ScriptMigrationDialog />);

    await screen.findByText("Import Superset scripts?");
    fireEvent.click(screen.getByRole("button", { name: "Don't ask again" }));

    await waitFor(() => expect(dismissScriptMigrationMock).toHaveBeenCalledWith("project-1"));
    expect(applyScriptMigrationMock).not.toHaveBeenCalled();
  });

  it("shows nothing when no config is detected", async () => {
    detectScriptMigrationMock.mockResolvedValue(null);
    render(<ScriptMigrationDialog />);

    await waitFor(() => expect(detectScriptMigrationMock).toHaveBeenCalledWith("project-1"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("does not probe without an open project", () => {
    selectedProjectId = null;
    render(<ScriptMigrationDialog />);

    expect(detectScriptMigrationMock).not.toHaveBeenCalled();
  });
});

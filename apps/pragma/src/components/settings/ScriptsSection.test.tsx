import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const readProjectScriptsFile = vi.hoisted(() => vi.fn());
const writeProjectScriptsFile = vi.hoisted(() => vi.fn(async () => {}));

vi.mock("@/lib/tauri", () => ({ readProjectScriptsFile, writeProjectScriptsFile }));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { ProjectScriptsSection } from "./ScriptsSection";

const FILE = {
  setup: ["bun install"],
  teardown: ["docker compose down"],
  runScripts: { run: { command: [{ left: "bun dev", right: "bun test --watch" }] } },
};

describe("ProjectScriptsSection", () => {
  beforeEach(() => {
    writeProjectScriptsFile.mockClear();
    readProjectScriptsFile.mockResolvedValue({
      exists: true,
      contents: JSON.stringify(FILE),
      path: "/repo/.pragma/scripts.json",
    });
  });

  it("saves one list and keeps the rest of the file as written", async () => {
    render(<ProjectScriptsSection projectId="p" projectName="repo" />);
    const setup = await screen.findByDisplayValue("bun install");

    fireEvent.change(setup, { target: { value: "bun install\n\n  cargo fetch  " } });
    fireEvent.blur(setup);

    await waitFor(() => expect(writeProjectScriptsFile).toHaveBeenCalledTimes(1));
    const [projectId, contents] = writeProjectScriptsFile.mock.calls[0] as unknown as [
      string,
      string,
    ];
    expect(projectId).toBe("p");
    expect(JSON.parse(contents)).toEqual({ ...FILE, setup: ["bun install", "cargo fetch"] });
  });

  it("drops a list's key when it is cleared", async () => {
    render(<ProjectScriptsSection projectId="p" projectName="repo" />);
    const teardown = await screen.findByDisplayValue("docker compose down");

    fireEvent.change(teardown, { target: { value: "  " } });
    fireEvent.blur(teardown);

    await waitFor(() => expect(writeProjectScriptsFile).toHaveBeenCalled());
    const contents = (writeProjectScriptsFile.mock.calls[0] as unknown as [string, string])[1];
    expect(JSON.parse(contents)).not.toHaveProperty("teardown");
  });

  it("shows a broken file instead of offering to overwrite it", async () => {
    readProjectScriptsFile.mockResolvedValue({ exists: true, contents: "{ nope", path: "x" });

    render(<ProjectScriptsSection projectId="p" projectName="repo" />);

    expect(await screen.findByText("scripts.json needs attention")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});

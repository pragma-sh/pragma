import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const listOpenPortsMock = vi.fn();
const consumerRenderMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  listOpenPorts: (...args: unknown[]) => listOpenPortsMock(...args),
}));

vi.mock("@/state/workspace-context", () => ({
  useWorkspace: () => ({ selectedProjectId: "project" }),
}));

import { OpenPortsProvider, useOpenPorts } from "./open-ports-context";

const port = {
  port: 3000,
  process: "vite",
  pid: 123,
  tabId: "tab",
  worktreeId: "worktree",
};

function setDocumentHidden(hidden: boolean): void {
  Object.defineProperty(document, "hidden", { configurable: true, value: hidden });
}

function Consumer() {
  const ports = useOpenPorts();
  consumerRenderMock(ports);
  return <span>{ports.map((item) => item.port).join(",")}</span>;
}

function renderProvider() {
  return render(
    <OpenPortsProvider>
      <Consumer />
    </OpenPortsProvider>,
  );
}

describe("OpenPortsProvider", () => {
  beforeEach(() => {
    setDocumentHidden(false);
    listOpenPortsMock.mockReset();
    consumerRenderMock.mockReset();
  });

  afterEach(() => {
    cleanup();
    setDocumentHidden(false);
    vi.useRealTimers();
  });

  it("pauses polling while hidden and refreshes when visible or focused", async () => {
    vi.useFakeTimers();
    setDocumentHidden(true);
    listOpenPortsMock.mockResolvedValue([port]);
    renderProvider();

    act(() => vi.advanceTimersByTime(6000));
    window.dispatchEvent(new Event("focus"));
    expect(listOpenPortsMock).not.toHaveBeenCalled();

    setDocumentHidden(false);
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(listOpenPortsMock).toHaveBeenCalledTimes(1);
    expect(screen.getByText("3000")).toBeInTheDocument();

    await act(async () => window.dispatchEvent(new Event("focus")));
    expect(listOpenPortsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps context value stable when poll results are unchanged", async () => {
    listOpenPortsMock.mockResolvedValue([port]);
    renderProvider();
    await screen.findByText("3000");
    const rendersAfterInitialResult = consumerRenderMock.mock.calls.length;

    await act(async () => window.dispatchEvent(new Event("focus")));

    expect(listOpenPortsMock).toHaveBeenCalledTimes(2);
    expect(consumerRenderMock).toHaveBeenCalledTimes(rendersAfterInitialResult);
  });
});

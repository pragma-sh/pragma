import type { Tab } from "@pragma/constants";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readDaemonLogMock = vi.fn();

vi.mock("@/lib/tauri", () => ({
  readDaemonLog: () => readDaemonLogMock(),
}));

// CodeMirror's DOM measurement is unreliable under jsdom; back it with a plain
// element that just exposes the rendered value.
vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value }: { value: string }) => <pre aria-label="log">{value}</pre>,
}));

import { LogView } from "./LogView";

function logTab(): Tab {
  return {
    id: "log-1",
    projectId: "proj",
    worktreeId: "wt",
    kind: "log",
    title: "Server Logs",
    url: null,
    filePath: null,
    diffSide: null,
    diffCommit: null,
    prNumber: null,
    pluginId: null,
    pluginViewId: null,
    pluginPayload: null,
    pluginDedupeKey: null,
    agentId: null,
    userRenamed: false,
    orderIndex: 0,
    createdAt: "now",
  };
}

afterEach(cleanup);
beforeEach(() => {
  readDaemonLogMock.mockReset();
});

describe("LogView", () => {
  it("reads the server log on mount", async () => {
    readDaemonLogMock.mockResolvedValue("daemon started\n");
    render(<LogView tab={logTab()} />);
    await waitFor(() => expect(readDaemonLogMock).toHaveBeenCalledTimes(1));
    expect(await screen.findByLabelText("log")).toHaveTextContent("daemon started");
  });

  it("shows a placeholder message for an empty log", async () => {
    readDaemonLogMock.mockResolvedValue("");
    render(<LogView tab={logTab()} />);
    expect(await screen.findByLabelText("log")).toHaveTextContent("The server log is empty.");
  });

  it("re-reads when Refresh is clicked", async () => {
    readDaemonLogMock.mockResolvedValue("first\n");
    render(<LogView tab={logTab()} />);
    await waitFor(() => expect(readDaemonLogMock).toHaveBeenCalledTimes(1));

    readDaemonLogMock.mockResolvedValue("first\nsecond\n");
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => expect(readDaemonLogMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByLabelText("log")).toHaveTextContent("second");
  });

  it("surfaces a retry on read failure", async () => {
    readDaemonLogMock.mockRejectedValueOnce(new Error("no socket"));
    render(<LogView tab={logTab()} />);
    await screen.findByText("no socket");

    readDaemonLogMock.mockResolvedValue("recovered\n");
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    expect(await screen.findByLabelText("log")).toHaveTextContent("recovered");
  });
});

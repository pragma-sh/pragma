import { beforeEach, describe, expect, it, vi } from "vitest";

const sdkMocks = vi.hoisted(() => ({
  reportAttention: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportCleared: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportMessage: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportSessionName: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStarted: vi.fn((..._args: unknown[]) => Promise.resolve({})),
  reportStopped: vi.fn((..._args: unknown[]) => Promise.resolve({})),
}));

vi.mock("@pragma-sh/sdk", () => ({
  hasPragmaEnvironment: () => true,
  reportAttention: (...args: unknown[]) => sdkMocks.reportAttention(...args),
  reportCleared: (...args: unknown[]) => sdkMocks.reportCleared(...args),
  reportMessage: (...args: unknown[]) => sdkMocks.reportMessage(...args),
  reportSessionName: (...args: unknown[]) => sdkMocks.reportSessionName(...args),
  reportStarted: (...args: unknown[]) => sdkMocks.reportStarted(...args),
  reportStopped: (...args: unknown[]) => sdkMocks.reportStopped(...args),
}));

import { runtimeEventsFromV2 } from "./events";
import PragmaOpencodeV2Plugin from "./index";

beforeEach(() => {
  for (const mock of Object.values(sdkMocks)) mock.mockClear();
});

describe("runtimeEventsFromV2", () => {
  it("maps a v2 subagent session onto a v1 child session", () => {
    expect(
      runtimeEventsFromV2({
        type: "session.created",
        data: { sessionID: "ses_child", parentID: "ses_root", title: "Explore" },
      }),
    ).toEqual([
      {
        type: "session.created",
        properties: { info: { id: "ses_child", parentID: "ses_root", title: "Explore" } },
      },
    ]);
  });

  it("exposes a shell permission's resources as the command", () => {
    const [event] = runtimeEventsFromV2({
      type: "permission.asked",
      data: { id: "per_1", sessionID: "ses_root", action: "bash", resources: ["npm test"] },
    });
    expect(event?.properties).toMatchObject({ type: "bash", command: "npm test" });
  });

  it("asks the question tool's question, not its short header", () => {
    const [event] = runtimeEventsFromV2({
      type: "form.created",
      data: {
        form: {
          id: "frm_2",
          sessionID: "ses_root",
          title: "Question",
          fields: [
            {
              key: "q0",
              type: "string",
              title: "Choice",
              description: "Choose Red or Blue?",
              options: [{ value: "red", label: "Red" }],
            },
          ],
        },
      },
    });
    expect(event?.properties).toMatchObject({
      questions: [{ question: "Choose Red or Blue?", options: [{ label: "Red" }] }],
    });
  });

  it("turns a form into a question with its field options", () => {
    const [event] = runtimeEventsFromV2({
      type: "form.created",
      data: {
        form: {
          id: "frm_1",
          sessionID: "ses_root",
          title: "Question",
          fields: [
            {
              key: "q0",
              type: "string",
              title: "Pick a color",
              options: [{ value: "red", label: "Red", description: "Warm" }],
            },
          ],
        },
      },
    });
    expect(event).toEqual({
      type: "question.asked",
      properties: {
        id: "frm_1",
        sessionID: "ses_root",
        questions: [{ question: "Pick a color", options: [{ label: "Red", description: "Warm" }] }],
      },
    });
  });

  it("treats a user interrupt as an abort and ignores unknown events", () => {
    expect(
      runtimeEventsFromV2({
        type: "session.execution.interrupted",
        data: { sessionID: "ses_root", reason: "user" },
      }),
    ).toEqual([
      {
        type: "session.error",
        properties: { sessionID: "ses_root", error: { name: "MessageAbortedError" } },
      },
    ]);
    expect(runtimeEventsFromV2({ type: "vcs.branch.updated", data: {} })).toEqual([]);
  });
});

describe("PragmaOpencodeV2Plugin", () => {
  it("is a server entry that reports nothing", async () => {
    expect(PragmaOpencodeV2Plugin.id).toBe("pragma.opencode");
    await PragmaOpencodeV2Plugin.setup({} as never);
    for (const mock of Object.values(sdkMocks)) expect(mock).not.toHaveBeenCalled();
  });
});

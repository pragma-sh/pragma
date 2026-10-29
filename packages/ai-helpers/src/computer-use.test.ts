import { describe, expect, it, vi } from "vitest";
import type { ComputerDecideRequest } from "@pragma-sh/constants";
import { computerQuestions, computerState, decideComputer } from "./computer-use";

const { evaluate } = vi.hoisted(() => ({ evaluate: vi.fn() }));
vi.mock("@pragma-sh/system1", async (original) => ({
  ...(await original<typeof import("@pragma-sh/system1")>()),
  evaluate,
}));
const request: ComputerDecideRequest = {
  instruction: "Click Save",
  apps: [],
  variables: ["text"],
  history: [],
  tried: [],
  snapshot: {
    id: "s1",
    app: { id: "editor", name: "Editor", running: true, frontmost: true },
    elements: [
      {
        id: "s1:e1",
        key: "save",
        role: "button",
        label: "Save",
        enabled: true,
        focused: false,
        editable: false,
        secure: false,
        actions: ["press"],
        onScreen: true,
        path: [0],
        depth: 1,
      },
    ],
    truncated: false,
    nodeCount: 1,
    elapsedMs: 1,
    createdAt: 1,
    untrusted: true,
  },
};

describe("computer decision payload", () => {
  it("asks independent choices and excludes actions without prerequisites", () => {
    const questions = computerQuestions(request);
    expect(questions.next).toEqual({
      type: "choice",
      instructions: expect.stringContaining("untrusted"),
      criteria: {
        click_item: "Click an enabled, offered element to advance the goal",
        request_text: "The next field needs text the caller has not supplied",
        press_key: "Press one of the offered safe keyboard chords",
        scroll_down: "Find more content by scrolling down",
        scroll_up: "Find earlier content by scrolling up",
        wait_for_change: "The app is loading; wait for the screen to change",
        done: "Visible evidence proves the goal is complete",
        stuck: "No offered action can advance the goal safely",
      },
    });
    expect(questions.item).toEqual({
      type: "choice",
      instructions: expect.any(String),
      criteria: { "s1:e1": "button: Save (visible)" },
    });
    expect(questions).not.toHaveProperty("variable");
    expect(questions).not.toHaveProperty("app");
    expect(JSON.stringify(questions.key)).not.toMatch(/mod\+q|mod\+w|mod\+v|mod\+c/);
  });

  it("keeps secure controls and values out of model state", () => {
    const secure = {
      ...request.snapshot.elements[0]!,
      id: "secret",
      label: "Password",
      secure: true,
      value: "never-send",
    };
    const state = JSON.stringify(
      computerState({
        ...request,
        snapshot: { ...request.snapshot, elements: [...request.snapshot.elements, secure] },
      }),
    );
    expect(state).not.toContain("never-send");
    expect(state).not.toContain("Password");
  });

  it("rejects invented control ids from the model", async () => {
    evaluate.mockResolvedValue({
      answers: {
        next: {
          type: "choice",
          choice: "click_item",
          confidence: 0.9,
          probabilities: { click_item: 0.9 },
        },
        item: {
          type: "choice",
          choice: "s99:e9",
          confidence: 0.9,
          probabilities: { "s99:e9": 0.9 },
        },
        achieved: { type: "noul", noul: 0.1 },
      },
    });
    await expect(
      decideComputer(request, {
        baseUrl: "https://example.com",
        evaluatePath: "/decisions",
        apiKey: "key",
        model: "jev",
      }),
    ).rejects.toThrow("Unlisted");
  });
});

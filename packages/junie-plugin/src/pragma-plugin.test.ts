import { describe, expect, it } from "vitest";

import { collectAgentText, findResponse } from "./acp";
import { parseJunieModels } from "./pragma-plugin";

/** A trimmed `session/new` result in the shape Junie 26.8.3 answers with. */
const SESSION_RESULT = {
  sessionId: "session-260806-110849-19an",
  configOptions: [
    {
      type: "select",
      id: "model",
      currentValue: "gemini-3-flash-preview",
      options: [
        { value: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
        { value: "claude-opus-5", name: "Claude Opus 5" },
        { value: "broken" },
      ],
    },
    {
      type: "select",
      id: "effort",
      currentValue: "high",
      options: [
        { value: "low", name: "◎ Low effort" },
        { value: "high", name: "◕ High effort" },
      ],
    },
    { type: "select", id: "brave_mode", currentValue: "auto", options: [{ value: "off" }] },
  ],
};

describe("parseJunieModels", () => {
  it("reads the model catalog and attaches the shared effort levels", () => {
    const reasoning = [
      { id: "low", name: "◎ Low effort" },
      { id: "high", name: "◕ High effort" },
    ];
    expect(parseJunieModels(SESSION_RESULT)).toEqual([
      { id: "gemini-3-flash-preview", name: "Gemini 3 Flash Preview", reasoning },
      { id: "claude-opus-5", name: "Claude Opus 5", reasoning },
      { id: "broken", name: "broken", reasoning },
    ]);
  });

  it("returns nothing for a result without config options", () => {
    expect(parseJunieModels({ sessionId: "s" })).toEqual([]);
    expect(parseJunieModels(null)).toEqual([]);
  });
});

describe("findResponse", () => {
  const stdout = [
    '{"type":"…","method":"session/update","params":{}}',
    "not json",
    '{"id":2,"result":{"sessionId":"s"},"jsonrpc":"2.0"}',
    '{"id":3,"error":{"message":"Method not found"},"jsonrpc":"2.0"}',
  ].join("\n");

  it("finds a result by request id", () => {
    expect(findResponse(stdout, 2)).toEqual({ ok: true, result: { sessionId: "s" } });
  });

  it("surfaces an error response", () => {
    expect(findResponse(stdout, 3)).toEqual({ ok: false, message: "Method not found" });
  });

  it("returns undefined when the response never arrived", () => {
    expect(findResponse(stdout, 9)).toBeUndefined();
  });
});

describe("collectAgentText", () => {
  it("concatenates the agent message chunks of a slash-command reply", () => {
    const stdout = [
      '{"method":"session/update","params":{"update":{"sessionUpdate":"available_commands_update"}}}',
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"License: X"}}}}',
      '{"method":"session/update","params":{"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"Balance left: $1.00"}}}}',
    ].join("\n");
    expect(collectAgentText(stdout)).toBe("License: XBalance left: $1.00");
  });
});

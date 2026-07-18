import { describe, expect, it } from "vitest";

import { planInteractiveScripts, planNamedScript } from "./scripts";

describe("planNamedScript", () => {
  it("plans a string entry as one normal command", () => {
    expect(planNamedScript("run", ["bun run dev"])).toEqual({
      commands: ["bun run dev"],
      items: [{ commandIndexes: [0], layout: null }],
    });
  });

  it("plans nested horizontal and vertical split entries", () => {
    expect(
      planNamedScript("run", [
        {
          left: "bun run dev",
          right: {
            top: "fastapi dev main.py",
            bottom: "bunx convex dev",
          },
        },
      ]),
    ).toEqual({
      commands: ["bun run dev", "fastapi dev main.py", "bunx convex dev"],
      items: [
        {
          commandIndexes: [0, 1, 2],
          layout: {
            kind: "split",
            direction: "horizontal",
            children: [
              { kind: "pane", commandIndex: 0 },
              {
                kind: "split",
                direction: "vertical",
                children: [
                  { kind: "pane", commandIndex: 1 },
                  { kind: "pane", commandIndex: 2 },
                ],
              },
            ],
          },
        },
      ],
    });
  });

  it("uses the script name in validation errors", () => {
    expect(() => planNamedScript("build", [" "])).toThrow("build[0] must not be empty");
    expect(() => planInteractiveScripts([" "], "custom")).toThrow("custom[0] must not be empty");
  });

  it("rejects empty commands", () => {
    expect(() => planNamedScript("run", [" "])).toThrow("run[0] must not be empty");
  });

  it("rejects mixed split axes", () => {
    expect(() => planNamedScript("run", [{ left: "a", top: "b" } as never])).toThrow(
      "exactly one split axis",
    );
  });

  it("rejects unknown split keys", () => {
    expect(() => planNamedScript("run", [{ left: "a", right: "b", center: "c" } as never])).toThrow(
      "run[0] has unknown key center",
    );
  });
});

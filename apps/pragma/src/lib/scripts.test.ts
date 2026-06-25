import { describe, expect, it } from "vitest";

import { planBuildScripts, planInteractiveScripts, planRunScripts } from "./scripts";

describe("planRunScripts", () => {
  it("plans a string entry as one normal command", () => {
    expect(planRunScripts(["bun run dev"])).toEqual({
      commands: ["bun run dev"],
      items: [{ commandIndexes: [0], layout: null }],
    });
  });

  it("plans nested horizontal and vertical split entries", () => {
    expect(
      planRunScripts([
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

  it("uses the script kind in validation errors", () => {
    expect(() => planBuildScripts([" "])).toThrow("build[0] must not be empty");
    expect(() => planInteractiveScripts([" "], "custom")).toThrow("custom[0] must not be empty");
  });

  it("rejects empty commands", () => {
    expect(() => planRunScripts([" "])).toThrow("run[0] must not be empty");
  });

  it("rejects mixed split axes", () => {
    expect(() => planRunScripts([{ left: "a", top: "b" } as never])).toThrow(
      "exactly one split axis",
    );
  });

  it("rejects unknown split keys", () => {
    expect(() => planRunScripts([{ left: "a", right: "b", center: "c" } as never])).toThrow(
      "run[0] has unknown key center",
    );
  });
});

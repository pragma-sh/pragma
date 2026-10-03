import { describe, expect, it } from "vitest";

import { parseInputs, parseTarget } from "./cli.ts";

describe("parseTarget", () => {
  it("reads digits as an index and anything else as a selector", () => {
    expect(parseTarget("12")).toEqual({ index: 12 });
    expect(parseTarget("[data-tour=add-project]")).toEqual({ selector: "[data-tour=add-project]" });
    expect(parseTarget(undefined)).toEqual({});
  });
});

describe("parseInputs", () => {
  it("splits on the first equals sign", () => {
    expect(parseInputs(["name=feature-x", "url=http://a?b=c"])).toEqual({
      name: "feature-x",
      url: "http://a?b=c",
    });
    expect(() => parseInputs(["oops"])).toThrow(/name=value/);
  });
});

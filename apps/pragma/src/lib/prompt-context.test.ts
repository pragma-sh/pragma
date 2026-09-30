import { describe, expect, it } from "vitest";

import { hasMention, unescapeMarkdown } from "./prompt-context";

describe("unescapeMarkdown", () => {
  it("drops serializer escapes", () => {
    expect(unescapeMarkdown("@src/my\\_file.ts and \\#12")).toBe("@src/my_file.ts and #12");
  });
});

describe("hasMention", () => {
  it("finds whole-token mentions", () => {
    expect(hasMention("fix @#12 please", "@#12")).toBe(true);
    expect(hasMention("@src/a.ts", "@src/a.ts")).toBe(true);
    expect(hasMention("see @README.md.", "@README.md")).toBe(true);
    expect(hasMention("see @#12, then", "@#12")).toBe(true);
  });

  it("rejects prefixes of longer mentions and embedded matches", () => {
    expect(hasMention("fix @#123", "@#12")).toBe(false);
    expect(hasMention("open @src/a.ts", "@src/a")).toBe(false);
    expect(hasMention("mail me@#12", "@#12")).toBe(false);
    expect(hasMention("removed", "@#12")).toBe(false);
  });
});

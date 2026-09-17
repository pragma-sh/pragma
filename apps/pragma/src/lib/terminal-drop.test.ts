import { describe, expect, it } from "vitest";

import { quoteShellPath } from "./terminal-drop";

describe("quoteShellPath", () => {
  it("leaves plain paths untouched", () => {
    expect(quoteShellPath("/tmp/drops/shot.png", "posix")).toBe("/tmp/drops/shot.png");
    expect(quoteShellPath("C:/Temp/shot.png", "powershell")).toBe("C:/Temp/shot.png");
  });

  it("backslash-escapes POSIX specials like native terminals do", () => {
    expect(quoteShellPath("/tmp/Screen Shot (1).png", "posix")).toBe(
      "/tmp/Screen\\ Shot\\ \\(1\\).png",
    );
    expect(quoteShellPath("/tmp/it's.png", "posix")).toBe("/tmp/it\\'s.png");
  });

  it("single-quotes POSIX paths with control characters", () => {
    expect(quoteShellPath("/tmp/a\nb's", "posix")).toBe("'/tmp/a\nb'\\''s'");
  });

  it("single-quotes PowerShell paths and doubles embedded quotes", () => {
    expect(quoteShellPath("C:\\Users\\me\\it's here.png", "powershell")).toBe(
      "'C:\\Users\\me\\it''s here.png'",
    );
  });
});

import type { Terminal } from "@xterm/xterm";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createFileLinkProvider,
  findFilePathCandidates,
  setTerminalLinkHandler,
  toWorktreeRelativePath,
} from "@/lib/terminal-links";

function mockTerminalWithLine(text: string): Terminal {
  const cells = [...text].map((char) => ({
    getWidth: () => 1,
    getChars: () => char,
  }));
  const line = {
    length: cells.length,
    getCell(column: number, cell: { getWidth: () => number; getChars: () => string }) {
      const data = cells[column];
      if (data) {
        cell.getWidth = data.getWidth;
        cell.getChars = data.getChars;
      }
    },
  };
  const nullCell = { getWidth: () => 1, getChars: () => " " };
  return {
    buffer: {
      active: {
        getLine: (index: number) => (index === 0 ? line : null),
        getNullCell: () => ({ ...nullCell }),
      },
    },
  } as unknown as Terminal;
}

async function provideLinksForLine(
  provider: ReturnType<typeof createFileLinkProvider>,
  lineNumber: number,
): Promise<void> {
  await new Promise<void>((resolve) => {
    provider.provideLinks(lineNumber, () => resolve());
  });
}

afterEach(() => {
  setTerminalLinkHandler(null);
});

describe("findFilePathCandidates", () => {
  it("matches paths with a separator and bare filenames with an extension", () => {
    const found = findFilePathCandidates("see src/lib/foo.ts and main.rs for details");
    expect(found.map((candidate) => candidate.path)).toEqual(["src/lib/foo.ts", "main.rs"]);
  });

  it("reports char-index ranges covering the path", () => {
    const text = "edit src/foo.ts now";
    const [candidate] = findFilePathCandidates(text);
    expect(candidate).toBeDefined();
    expect(text.slice(candidate!.start, candidate!.end)).toBe("src/foo.ts");
  });

  it("strips a :line:col locator from the path", () => {
    const [candidate] = findFilePathCandidates("apps/pragma/src/main.tsx:42:7: error");
    expect(candidate?.path).toBe("apps/pragma/src/main.tsx");
  });

  it("strips wrapping brackets and trailing punctuation", () => {
    expect(findFilePathCandidates("(see src/foo.ts).").map((c) => c.path)).toEqual(["src/foo.ts"]);
    expect(findFilePathCandidates('"./bar.rs",').map((c) => c.path)).toEqual(["./bar.rs"]);
  });

  it("ignores URLs, plain words, and bare numbers", () => {
    expect(findFilePathCandidates("visit https://example.com/page now")).toEqual([]);
    expect(findFilePathCandidates("the quick brown fox")).toEqual([]);
    expect(findFilePathCandidates("took 12:30 minutes")).toEqual([]);
  });

  it("ignores bare path roots", () => {
    expect(findFilePathCandidates("cd / && cd .. && ls .")).toEqual([]);
  });
});

describe("toWorktreeRelativePath", () => {
  const cwd = "/Users/me/project";

  it("makes an absolute path under the worktree relative", () => {
    expect(toWorktreeRelativePath("/Users/me/project/src/foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("tolerates a trailing slash on the worktree root", () => {
    expect(toWorktreeRelativePath("/Users/me/project/src/foo.ts", `${cwd}/`)).toBe("src/foo.ts");
  });

  it("returns relative paths as-is, stripping a leading ./", () => {
    expect(toWorktreeRelativePath("src/foo.ts", cwd)).toBe("src/foo.ts");
    expect(toWorktreeRelativePath("./src/foo.ts", cwd)).toBe("src/foo.ts");
  });

  it("rejects paths outside the worktree", () => {
    expect(toWorktreeRelativePath("/etc/passwd", cwd)).toBeNull();
    expect(toWorktreeRelativePath("/Users/me/project", cwd)).toBeNull();
    expect(toWorktreeRelativePath("../escape.ts", cwd)).toBeNull();
    expect(toWorktreeRelativePath("a/../../escape.ts", cwd)).toBeNull();
  });
});

describe("createFileLinkProvider", () => {
  const cwd = "/Users/me/project";

  it("dedupes pathExists checks for the same path within and across provideLinks calls", async () => {
    const pathExists = vi.fn().mockResolvedValue(true);
    setTerminalLinkHandler({
      openUrl: vi.fn(),
      openFile: vi.fn(),
      pathExists,
    });

    const terminal = mockTerminalWithLine("see src/foo.ts and src/foo.ts again");
    const provider = createFileLinkProvider(terminal, "tab-1", "wt-1", cwd);

    await provideLinksForLine(provider, 1);
    await provideLinksForLine(provider, 1);

    expect(pathExists).toHaveBeenCalledTimes(1);
    expect(pathExists).toHaveBeenCalledWith("wt-1", "src/foo.ts");
  });
});

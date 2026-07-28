/// <reference types="node" />

// Runs a `*.sh` build script under a POSIX shell on every platform.
//
// On Windows the answer is Git Bash, which ships with Git for Windows (see the
// Windows notes in AGENTS.md). Resolving it by name is not safe: a bare `bash`
// on the Windows `PATH` hits `C:\Windows\system32\bash.exe` — the WSL launcher —
// whenever WSL is installed, and that shell has a Linux `PATH` with no `rustc`,
// `cargo`, or `bun` on it. CI's `windows-latest` image has no WSL, so the
// breakage only ever shows up on developer machines. We therefore derive Git
// Bash from the `git` executable itself rather than trusting `PATH` order.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";

/** Locations of `bash.exe` relative to the directory holding `git.exe`. */
const GIT_BASH_RELATIVE = [
  join("..", "bin", "bash.exe"), // <git>/cmd/git.exe -> <git>/bin/bash.exe
  join("..", "..", "bin", "bash.exe"), // <git>/mingw64/bin/git.exe -> <git>/bin/bash.exe
  "bash.exe", // <git>/bin/git.exe -> <git>/bin/bash.exe
];

/** Every `git.exe` on `PATH`, in `PATH` order. */
function gitCandidates(): string[] {
  return (process.env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => entry.length > 0)
    .map((entry) => join(entry, "git.exe"))
    .filter((candidate) => existsSync(candidate));
}

function explicitBash(): string | undefined {
  const explicit = process.env.PRAGMA_BASH;
  if (!explicit) return undefined;
  if (!existsSync(explicit)) {
    throw new Error(`PRAGMA_BASH is set to ${explicit}, which does not exist`);
  }
  return explicit;
}

function bashNearGit(): string | undefined {
  for (const root of gitCandidates().map(dirname)) {
    for (const relative of GIT_BASH_RELATIVE) {
      const candidate = join(root, relative);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Default install locations, checked when no `git.exe` is on `PATH` at all. */
const GIT_INSTALL_ROOTS = ["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"];

function bashInDefaultInstall(): string | undefined {
  for (const root of GIT_INSTALL_ROOTS) {
    const candidate = join(root, "bin", "bash.exe");
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

function windowsBash(): string {
  const bash = explicitBash() ?? bashNearGit() ?? bashInDefaultInstall();
  if (!bash) {
    throw new Error(
      "could not find Git Bash. Install Git for Windows, or point PRAGMA_BASH at a bash.exe.",
    );
  }
  return bash;
}

const [script, ...args] = process.argv.slice(2);
if (!script) {
  throw new Error("usage: bun run scripts/run-shell-script.ts <script.sh> [args...]");
}

const shell = process.platform === "win32" ? windowsBash() : "bash";
const result = spawnSync(shell, [script, ...args], { stdio: "inherit" });

if (result.error) throw result.error;
process.exit(result.status ?? 1);

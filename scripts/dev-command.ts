/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import { constants } from "@pragma/constants";
import type { WorkspaceSnapshot } from "@pragma/constants";

function usage(): never {
  throw new Error('usage: bun run dev:command -- <dev-id> "<command>"');
}

function appDataDir(): string {
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support", constants.app.identifier);
  }

  const dataHome = process.env.XDG_DATA_HOME ?? join(homedir(), ".local", "share");
  return join(dataHome, constants.app.identifier);
}

function targetPaths(devId: string): { cli: string; serverDir: string; socket: string } {
  const channel = devId.startsWith("pragma-dev-") ? devId : `pragma-dev-${devId}`;
  if (!/^pragma-dev-[0-9a-f]{16}$/i.test(channel)) {
    throw new Error("dev id must be a 16-character hexadecimal channel id");
  }

  const instanceDir = join(appDataDir(), channel);
  const serverDir =
    process.platform === "linux" && process.env.XDG_RUNTIME_DIR
      ? join(process.env.XDG_RUNTIME_DIR, channel)
      : instanceDir;
  return {
    cli: join(instanceDir, "bin", "pragma-cli"),
    serverDir,
    socket: join(serverDir, "daemon.sock"),
  };
}

function worktreeForCwd(serverDir: string): string {
  const snapshotPath = join(serverDir, "workspace.json");
  if (!existsSync(snapshotPath)) {
    throw new Error(`target dev build has no workspace snapshot: ${snapshotPath}`);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as WorkspaceSnapshot;
  const cwd = resolve(process.cwd());
  let worktree: WorkspaceSnapshot["worktrees"][number] | undefined;
  for (const candidate of snapshot.worktrees) {
    const fromWorktree = relative(resolve(candidate.path), cwd);
    const containsCwd =
      fromWorktree === "" || (!fromWorktree.startsWith("..") && !isAbsolute(fromWorktree));
    if (containsCwd && (!worktree || candidate.path.length > worktree.path.length)) {
      worktree = candidate;
    }
  }

  if (!worktree) {
    throw new Error(`current directory is not a worktree in target dev build: ${cwd}`);
  }
  return worktree.id;
}

function main(): void {
  const [devId, ...commandParts] = process.argv.slice(2);
  if (!devId || commandParts.length === 0) usage();

  const command = commandParts.join(" ");
  const target = targetPaths(devId);
  if (!existsSync(target.socket)) {
    throw new Error(`target dev build is not running: ${target.socket}`);
  }
  if (!existsSync(target.cli)) {
    throw new Error(`target dev build CLI is not installed: ${target.cli}`);
  }

  const worktree = worktreeForCwd(target.serverDir);
  const child = spawnSync(
    target.cli,
    ["tab", "open", "--worktree", worktree, "--kind", "terminal", "--command", command],
    {
      env: {
        ...process.env,
        PRAGMA_SERVER_SOCKET: target.socket,
        PRAGMA_DAEMON_SOCKET: target.socket,
      },
      stdio: "inherit",
    },
  );
  if (child.error) throw child.error;
  if (child.status !== 0) process.exit(child.status ?? 1);
}

try {
  main();
} catch (error: unknown) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

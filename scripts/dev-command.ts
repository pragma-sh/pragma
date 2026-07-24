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

/** Resolved on-disk locations of a running dev build. */
interface DevTarget {
  cli: string;
  serverDir: string;
  socket: string;
}

/** Normalizes a bare or prefixed dev id into its `pragma-dev-<hex16>` channel id. */
function devChannelId(devId: string): string {
  const channel = devId.startsWith("pragma-dev-") ? devId : `pragma-dev-${devId}`;
  if (!/^pragma-dev-[0-9a-f]{16}$/i.test(channel)) {
    throw new Error("dev id must be a 16-character hexadecimal channel id");
  }
  return channel;
}

/** Linux puts the server socket under `XDG_RUNTIME_DIR`; macOS keeps it in the instance dir. */
function serverDirFor(channel: string, instanceDir: string): string {
  if (process.platform === "linux" && process.env.XDG_RUNTIME_DIR) {
    return join(process.env.XDG_RUNTIME_DIR, channel);
  }
  return instanceDir;
}

function targetPaths(devId: string): DevTarget {
  const channel = devChannelId(devId);
  const instanceDir = join(appDataDir(), channel);
  const serverDir = serverDirFor(channel, instanceDir);
  return {
    cli: join(instanceDir, "bin", "pragma-cli"),
    serverDir,
    socket: join(serverDir, "daemon.sock"),
  };
}

/** True when `cwd` is `worktreePath` itself or nested inside it. */
function containsPath(worktreePath: string, cwd: string): boolean {
  const fromWorktree = relative(resolve(worktreePath), cwd);
  return fromWorktree === "" || (!fromWorktree.startsWith("..") && !isAbsolute(fromWorktree));
}

/** Deepest (longest-path) snapshot worktree containing `cwd`, if any. */
function deepestWorktreeContaining(
  worktrees: WorkspaceSnapshot["worktrees"],
  cwd: string,
): WorkspaceSnapshot["worktrees"][number] | undefined {
  return worktrees
    .filter((candidate) => containsPath(candidate.path, cwd))
    .toSorted((a, b) => b.path.length - a.path.length)[0];
}

function worktreeForCwd(serverDir: string): string {
  const snapshotPath = join(serverDir, "workspace.json");
  if (!existsSync(snapshotPath)) {
    throw new Error(`target dev build has no workspace snapshot: ${snapshotPath}`);
  }

  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as WorkspaceSnapshot;
  const cwd = resolve(process.cwd());
  const worktree = deepestWorktreeContaining(snapshot.worktrees, cwd);
  if (!worktree) {
    throw new Error(`current directory is not a worktree in target dev build: ${cwd}`);
  }
  return worktree.id;
}

/** Fails fast when the target dev build is not running or has no installed CLI. */
function assertTargetReady(target: DevTarget): void {
  if (!existsSync(target.socket)) {
    throw new Error(`target dev build is not running: ${target.socket}`);
  }
  if (!existsSync(target.cli)) {
    throw new Error(`target dev build CLI is not installed: ${target.cli}`);
  }
}

/** Opens `command` in a new terminal tab of the target dev build's worktree. */
function openTerminalTab(target: DevTarget, worktree: string, command: string): void {
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

function main(): void {
  const [devId, ...commandParts] = process.argv.slice(2);
  if (!devId || commandParts.length === 0) usage();

  const target = targetPaths(devId);
  assertTargetReady(target);
  openTerminalTab(target, worktreeForCwd(target.serverDir), commandParts.join(" "));
}

try {
  main();
} catch (error: unknown) {
  console.error(`error: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}

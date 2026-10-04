/// <reference types="node" />

import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BridgeError, type BridgeToken } from "./bridge.ts";

/** Longest edge of an image sent to the model; a 5K retina capture is wasted tokens. */
const MODEL_IMAGE_MAX_EDGE = 1600;

function run(command: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const result = spawnSync(command, args, { encoding: "utf8" });
  return {
    ok: result.status === 0,
    stdout: result.stdout ?? "",
    stderr: (result.stderr ?? "") + (result.error ? String(result.error) : ""),
  };
}

/**
 * Brings the instance's window to the front. Not cosmetic: WebKit stops
 * painting an occluded window (xterm draws from `requestAnimationFrame`), so a
 * capture of a buried window shows a stale frame.
 */
export function raiseWindow(pid: number): void {
  if (process.platform === "darwin") {
    run("osascript", [
      "-e",
      `tell application "System Events" to set frontmost of (first application process whose unix id is ${pid}) to true`,
    ]);
  } else if (process.platform === "linux") {
    run("xdotool", ["search", "--pid", String(pid), "windowactivate"]);
  }
}

/** Preferred path: the dev app captures its own window through the bridge. */
async function captureViaBridge(instance: BridgeToken): Promise<Buffer> {
  const response = await fetch(`http://127.0.0.1:${instance.port}/screenshot`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: instance.token }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 404) {
    throw new BridgeError(
      "this dev build predates the bridge's /screenshot endpoint; restart `bun run dev`",
    );
  }
  if (!response.ok) throw new BridgeError(`bridge screenshot failed: ${await response.text()}`);
  return Buffer.from(await response.arrayBuffer());
}

const MAC_WINDOW_ID_SCRIPT = (pid: number) => `
ObjC.import("CoreGraphics");
const all = ObjC.deepUnwrap(ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionAll, 0)));
const own = all.filter((w) => w.kCGWindowOwnerPID === ${pid} && w.kCGWindowLayer === 0);
own.sort((a, b) => b.kCGWindowBounds.Width * b.kCGWindowBounds.Height - a.kCGWindowBounds.Width * a.kCGWindowBounds.Height);
own.length ? String(own[0].kCGWindowNumber) : "";
`;

/** Fallback: the OS screenshot tool, which needs the *terminal's* capture permission. */
function captureViaOs(pid: number, path: string): void {
  if (process.platform === "darwin") {
    const id = run("osascript", [
      "-l",
      "JavaScript",
      "-e",
      MAC_WINDOW_ID_SCRIPT(pid),
    ]).stdout.trim();
    if (!id) throw new BridgeError(`no window found for pid ${pid}`);
    const shot = run("screencapture", ["-x", "-o", `-l${id}`, path]);
    if (!shot.ok) {
      throw new BridgeError(
        `screencapture failed (${shot.stderr.trim()}); grant Screen Recording to this terminal, or restart the dev app so the bridge can capture itself`,
      );
    }
    return;
  }
  if (process.platform === "linux") {
    const id = run("xdotool", ["search", "--onlyvisible", "--pid", String(pid)])
      .stdout.trim()
      .split("\n")
      .pop();
    if (!id) throw new BridgeError(`no window found for pid ${pid} (is xdotool installed?)`);
    const shot = run("import", ["-window", id, path]);
    if (!shot.ok) throw new BridgeError(`import failed: ${shot.stderr.trim()}`);
    return;
  }
  throw new BridgeError(`window capture is not supported on ${process.platform}`);
}

/** Captures the dev app's window to `path` (PNG). Returns how it was captured. */
export async function captureWindow(
  instance: BridgeToken,
  path: string,
  options: { raise?: boolean } = {},
): Promise<"bridge" | "os"> {
  mkdirSync(dirname(path), { recursive: true });
  if (options.raise !== false) {
    raiseWindow(instance.pid);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  try {
    writeFileSync(path, await captureViaBridge(instance));
    return "bridge";
  } catch (bridgeError) {
    try {
      captureViaOs(instance.pid, path);
      return "os";
    } catch (osError) {
      throw new BridgeError(
        `could not capture the window.\n  bridge: ${(bridgeError as Error).message}\n  os: ${(osError as Error).message}`,
      );
    }
  }
}

/** Downscales a PNG for the model, returning base64. Falls back to the original. */
export function encodeForModel(path: string, scratchPath: string): string {
  let source = path;
  if (process.platform === "darwin") {
    const resized = run("sips", ["-Z", String(MODEL_IMAGE_MAX_EDGE), path, "--out", scratchPath]);
    if (resized.ok) source = scratchPath;
  } else {
    const resized = run("convert", [
      path,
      "-resize",
      `${MODEL_IMAGE_MAX_EDGE}x${MODEL_IMAGE_MAX_EDGE}>`,
      scratchPath,
    ]);
    if (resized.ok) source = scratchPath;
  }
  return readFileSync(source).toString("base64");
}

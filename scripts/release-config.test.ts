import { readFileSync } from "node:fs";
import { join } from "node:path";
import { join as joinConfigPath } from "node:path/posix";
import { describe, expect, test } from "bun:test";

import goApp from "../apps/pragma-go/app.json";
import config from "../release-please-config.json";

interface ExtraFile {
  type: string;
  path: string;
  jsonpath?: string;
}

const packages: Record<
  string,
  { component?: string; "extra-files"?: ExtraFile[]; "skip-github-release"?: boolean }
> = config.packages;

const ROOT = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

const plugins: Array<Record<string, unknown>> = config.plugins;
const linkedVersions = plugins.find((plugin) => plugin.type === "linked-versions") as
  | { components?: string[]; merge?: boolean }
  | undefined;

/**
 * Resolve an `extra-files` entry to the repo-relative file it writes. These are config
 * strings Release Please parses itself, not host paths — always `/`-separated, never
 * touched by the local filesystem — so they join under `path/posix` on every OS.
 */
function resolveExtraFile(packagePath: string, file: ExtraFile): string {
  return joinConfigPath(packagePath, file.path);
}

/** Every `extra-files` entry across the config, tagged with its component. */
function extraFiles(): Array<{ component: string; file: ExtraFile }> {
  return Object.entries(packages).flatMap(([component, entry]) =>
    (entry["extra-files"] ?? []).map((file) => ({ component, file })),
  );
}

describe("Release Please cannot rewrite the mobile runtime version", () => {
  // `runtimeVersion.policy` is `fingerprint` and `expo.version` is hashed into the
  // resolved `expoConfig`, so a release that rewrites it changes the runtime version
  // of every shipped build and cuts it off from all future OTA updates.
  test("no extra-file writes apps/pragma-go/app.json", () => {
    expect(extraFiles().filter(({ file }) => file.path.endsWith("app.json"))).toEqual([]);
  });

  test("the store version stays ahead of a 0.x desktop beta", () => {
    expect(goApp.expo.version).toBe("1.0.0");
  });
});

describe("gateway.apiVersion is hand-owned", () => {
  // Remote clients embed their copy at build time and ship on their own cadence, so
  // the moment a release bumps it every installed client refuses to pair.
  test("no extra-file writes it", () => {
    expect(extraFiles().filter(({ file }) => file.jsonpath?.includes("apiVersion"))).toEqual([]);
  });

  test("`bun run generate` does not sync it", () => {
    expect(read("packages/constants/scripts/generate-types.ts")).not.toContain("apiVersion");
  });

  test("mobile pairing gates on it, not on the daemon wire protocol", () => {
    const pairing = read("apps/pragma-go/lib/pairing.ts");
    expect(pairing).toContain("constants.gateway.apiVersion");
    expect(pairing).not.toContain("constants.daemon.protocolVersion");
  });
});

describe("the desktop group reaches the release PR", () => {
  // `linked-versions` defaults to merging its group into one extra candidate that
  // carries no version of its own. `node-workspace` drops any versionless candidate
  // outright (`WorkspacePlugin.run`), so with the default the entire desktop group —
  // the app, every crate, the published packages — silently vanishes from the release
  // PR and no `pragma-v*` tag is ever cut.
  test("linked-versions does not merge while node-workspace is enabled", () => {
    expect(plugins.some((plugin) => plugin.type === "node-workspace")).toBe(true);
    expect(linkedVersions?.merge).toBe(false);
  });

  test("the group version starts at the beta, not 1.0.0", () => {
    // A `0.0.0` manifest entry is not a previous release, so `bump-minor-pre-major`
    // never runs and Release Please falls through to `initial-version` — which
    // defaults to `1.0.0`.
    expect((config as { "initial-version"?: string })["initial-version"]).toBe("0.1.0");
  });
});

describe("the Tauri crate does not shadow the desktop component", () => {
  // `apps/pragma/src-tauri` is a member of the Cargo workspace and its crate is named
  // `pragma`, so the `cargo-workspace` plugin invents a release candidate for it whose
  // component collides with the real `pragma` app — a phantom `pragma-v0.0.1` GitHub
  // release with no installers attached. It needs its own config entry to be tamed.
  const crate: { component?: string; "skip-github-release"?: boolean } | undefined =
    packages["apps/pragma/src-tauri"];

  test("it is a configured package with a distinct component", () => {
    expect(crate?.component).toBe("pragma-desktop");
    expect(crate?.component).not.toBe(packages["apps/pragma"]?.component);
  });

  test("it never cuts a release of its own", () => {
    expect(crate?.["skip-github-release"]).toBe(true);
  });

  test("it stays pinned to the desktop group", () => {
    // Without this the `cargo-workspace` candidate is free to drift to its own patch
    // version again while every other assertion here still passes.
    expect(linkedVersions?.components).toContain(crate?.component);
  });

  test("its version is written by the rust strategy, not a duplicate extra-file", () => {
    // The rust strategy owns `apps/pragma/src-tauri/Cargo.toml`. An `extra-files` entry
    // resolving to the same file — as `apps/pragma` used to carry — is a second writer.
    const owned = "apps/pragma/src-tauri/Cargo.toml";
    const collisions = extraFiles()
      .map(({ component, file }) => ({ component, path: resolveExtraFile(component, file) }))
      .filter((entry) => entry.path === owned);
    expect(collisions).toEqual([]);
  });
});

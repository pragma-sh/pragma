import { readFileSync } from "node:fs";
import { join } from "node:path";
import { join as joinConfigPath } from "node:path/posix";
import { describe, expect, test } from "bun:test";

import goApp from "../apps/pragma-go/app.json";
import config from "../release-please-config.json";
import manifest from "../.release-please-manifest.json";
import official from "../packages/plugin-registry/official.json";

interface ExtraFile {
  type: string;
  path: string;
  jsonpath?: string;
}

const packages: Record<
  string,
  {
    component?: string;
    "extra-files"?: ExtraFile[];
    "release-as"?: string;
    "release-type"?: string;
    "skip-github-release"?: boolean;
  }
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

  test("the store version is never behind the desktop major", () => {
    expect(goApp.expo.version).toBe("1.0.0");
  });

  // `node-workspace` releases every `node` package whose workspace dependency moved, so
  // each desktop release would otherwise cut an empty Pragma Go release and store builds.
  test("a dependency bump alone never releases the mobile app", () => {
    expect(packages["apps/pragma-go"]?.["release-type"]).toBe("simple");
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

  test("a fresh component starts at 0.1.0, not 1.0.0", () => {
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

describe("release-as pins are one-shot", () => {
  // `release-as` forces the next release to that exact version — and every release
  // after it, until someone deletes it. Once the manifest reaches the pinned version
  // the pin has done its job and must go, or the next release PR re-proposes it.
  const versions: Record<string, string> = manifest;
  const pinned = Object.entries(packages).filter(([, entry]) => entry["release-as"]);

  test("every pin is still ahead of the released version", () => {
    const spent = pinned
      .filter(([path, entry]) => versions[path] === entry["release-as"])
      .map(([path]) => path);
    expect(spent).toEqual([]);
  });

  test("the linked desktop group is pinned all or nothing", () => {
    const group = new Set(linkedVersions?.components);
    const pins = new Set(
      Object.values(packages)
        .filter((entry) => entry.component && group.has(entry.component))
        .map((entry) => entry["release-as"] ?? null),
    );
    expect(pins.size).toBe(1);
  });
});

describe("the bench crate does not shadow its own component", () => {
  // `packages/bench` is a Cargo workspace member that depends on desktop crates. The
  // `cargo-workspace` plugin only honours `rust` candidates, so under any other release
  // type it force-bumps the crate from its own `Cargo.toml` (`0.0.0` -> `0.0.1`) and
  // appends a second, stray release entry next to the real one.
  const bench = config.packages["packages/bench"];

  test("its version is owned by the rust strategy", () => {
    expect(bench["release-type"]).toBe("rust");
  });

  test("its package.json follows the crate version", () => {
    expect(bench["extra-files"]).toContainEqual({
      type: "json",
      path: "package.json",
      jsonpath: "$.version",
    });
  });
});

describe("every official plugin release reaches npm", () => {
  // `publish-plugins` in release.yml derives each plugin's Release Please path from
  // its npm name and dispatches `plugins.yml` with that name as a choice input, so a
  // plugin missing from either list is tagged on every release and never published.
  const directories = official.packages.map(
    (name) => `packages/${name.replace("@pragma-sh/", "")}`,
  );

  test("each one is a Release Please package at the path its name implies", () => {
    expect(directories.filter((directory) => !(directory in packages))).toEqual([]);
  });

  test("each one stays out of the linked desktop group", () => {
    const components = directories.map((directory) => packages[directory]?.component);
    expect(
      components.filter((component) => linkedVersions?.components?.includes(component ?? "")),
    ).toEqual([]);
  });

  test("plugins.yml offers each one as a package to publish", () => {
    const workflow = Bun.YAML.parse(read(".github/workflows/plugins.yml")) as {
      on: { workflow_dispatch: { inputs: { package: { options: string[] } } } };
    };
    expect(workflow.on.workflow_dispatch.inputs.package.options.toSorted()).toEqual(
      official.packages.toSorted(),
    );
  });

  // npm rejects a provenance publish (E422) unless `repository.url` names the repo
  // the signing workflow ran in.
  test("each one names this repository, as provenance requires", () => {
    const unlinked = directories.filter((directory) => {
      const pkg = JSON.parse(read(join(directory, "package.json"))) as {
        repository?: { url?: string };
      };
      return pkg.repository?.url !== "git+https://github.com/pragma-sh/pragma.git";
    });
    expect(unlinked).toEqual([]);
  });

  test("release.yml dispatches plugins.yml for them", () => {
    expect(read(".github/workflows/release.yml")).toContain("gh workflow run plugins.yml");
  });
});

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import goApp from "../apps/pragma-go/app.json";
import config from "../release-please-config.json";

interface ExtraFile {
  type: string;
  path: string;
  jsonpath?: string;
}

const packages: Record<string, { "extra-files"?: ExtraFile[] }> = config.packages;

const ROOT = join(import.meta.dir, "..");

function read(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
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

import { existsSync } from "node:fs";
import { dirname, join, parse, resolve } from "node:path";

export type PackageManager = "bun" | "npm" | "pnpm" | "yarn";

const LOCKFILES: readonly [PackageManager, readonly string[]][] = [
  ["bun", ["bun.lock", "bun.lockb"]],
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["npm", ["package-lock.json"]],
];

/** Detects the nearest package manager by walking up from `startDir` and checking lockfiles. */
export function detectPackageManager(startDir: string = process.cwd()): PackageManager {
  let current = resolve(startDir);
  const root = parse(current).root;
  while (true) {
    for (const [manager, files] of LOCKFILES) {
      if (files.some((file) => existsSync(join(current, file)))) {
        return manager;
      }
    }
    if (current === root) {
      return "bun";
    }
    current = dirname(current);
  }
}

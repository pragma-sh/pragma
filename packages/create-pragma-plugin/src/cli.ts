#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { scaffoldPlugin, type ScaffoldCapability, type ScaffoldOptions } from "./scaffold";
import { detectPackageManager, type PackageManager } from "./package-manager";

interface CliArgs {
  directory: string | null;
  name?: string;
  packageManager?: PackageManager;
  force: boolean;
  capabilities: ScaffoldCapability[] | null;
}

const CAPABILITIES: ReadonlySet<ScaffoldCapability> = new Set(["ui", "commands", "agents"]);

async function main(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  if (!args.directory) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const capabilities = args.capabilities ?? (await promptCapabilities());
  const options: ScaffoldOptions = {
    directory: args.directory,
    ...(args.name === undefined ? {} : { name: args.name }),
    packageManager: args.packageManager ?? detectPackageManager(),
    capabilities,
    force: args.force,
  };
  const result = await scaffoldPlugin(options);
  output.write(`Created ${result.packageName} in ${result.directory}\n`);
  output.write(`Next: ${result.packageManager} install && ${result.packageManager} run build\n`);
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { directory: null, force: false, capabilities: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) {
      continue;
    }
    if (arg === "--name") {
      args.name = requireValue(argv, (index += 1), arg);
    } else if (arg === "--pm") {
      args.packageManager = parsePackageManager(requireValue(argv, (index += 1), arg));
    } else if (arg === "--force") {
      args.force = true;
    } else if (arg === "--capabilities") {
      args.capabilities = parseCapabilities(requireValue(argv, (index += 1), arg));
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else if (!args.directory) {
      args.directory = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }
  return args;
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePackageManager(value: string): PackageManager {
  if (value === "bun" || value === "npm" || value === "pnpm" || value === "yarn") {
    return value;
  }
  throw new Error(`unsupported package manager: ${value}`);
}

function parseCapabilities(value: string): ScaffoldCapability[] {
  const selected = value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  for (const capability of selected) {
    if (!CAPABILITIES.has(capability as ScaffoldCapability)) {
      throw new Error(`unsupported capability: ${capability}`);
    }
  }
  return selected as ScaffoldCapability[];
}

async function promptCapabilities(): Promise<ScaffoldCapability[]> {
  if (!input.isTTY || !output.isTTY) {
    return ["ui"];
  }
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(
      "Capabilities (comma-separated: ui, commands, agents) [ui,commands]: ",
    );
    return answer.trim() ? parseCapabilities(answer) : ["ui", "commands"];
  } finally {
    rl.close();
  }
}

function printUsage(): void {
  output.write(
    "Usage: create-pragma-plugin <directory> [--name <package-name>] [--pm bun|npm|pnpm|yarn] [--capabilities ui,commands,agents] [--force]\n",
  );
}

main(process.argv.slice(2)).catch((cause: unknown) => {
  const message = cause instanceof Error ? cause.message : String(cause);
  console.error(message);
  process.exitCode = 1;
});

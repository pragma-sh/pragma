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
const PACKAGE_MANAGERS: ReadonlySet<PackageManager> = new Set(["bun", "npm", "pnpm", "yarn"]);
const HELP_FLAGS = new Set(["--help", "-h"]);

type ValueFlagHandler = (args: CliArgs, value: string) => void;

const VALUE_FLAG_HANDLERS: Readonly<Record<string, ValueFlagHandler>> = {
  "--capabilities": (args, value) => {
    args.capabilities = parseCapabilities(value);
  },
  "--name": (args, value) => {
    args.name = value;
  },
  "--pm": (args, value) => {
    args.packageManager = parsePackageManager(value);
  },
};

async function main(argv: readonly string[]): Promise<void> {
  const options = await parseScaffoldOptions(argv);
  if (!options) {
    return;
  }
  const result = await scaffoldPlugin(options);
  output.write(`Created ${result.packageName} in ${result.directory}\n`);
  output.write(`Next: ${result.packageManager} install && ${result.packageManager} run build\n`);
}

async function parseScaffoldOptions(argv: readonly string[]): Promise<ScaffoldOptions | null> {
  const args = parseArgs(argv);
  if (!args.directory) {
    printUsage();
    process.exitCode = 1;
    return null;
  }
  return {
    directory: args.directory,
    ...optionalName(args.name),
    packageManager: args.packageManager ?? detectPackageManager(),
    capabilities: args.capabilities ?? (await promptCapabilities()),
    force: args.force,
  };
}

function optionalName(name: string | undefined): Pick<ScaffoldOptions, "name"> | object {
  return name === undefined ? {} : { name };
}

function parseArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { directory: null, force: false, capabilities: null };
  for (let index = 0; index < argv.length; ) {
    index = parseArg(argv, args, index);
  }
  return args;
}

function parseArg(argv: readonly string[], args: CliArgs, index: number): number {
  const arg = argv[index];
  return arg === undefined ? index + 1 : parsePresentArg(argv, args, index, arg);
}

function parsePresentArg(
  argv: readonly string[],
  args: CliArgs,
  index: number,
  arg: string,
): number {
  const valueHandler = VALUE_FLAG_HANDLERS[arg];
  if (valueHandler) {
    valueHandler(args, requireValue(argv, index + 1, arg));
    return index + 2;
  }
  if (arg === "--force") {
    args.force = true;
    return index + 1;
  }
  if (HELP_FLAGS.has(arg)) {
    printUsage();
    process.exit(0);
  }
  return parseDirectoryArg(args, index, arg);
}

function parseDirectoryArg(args: CliArgs, index: number, arg: string): number {
  if (!args.directory) {
    args.directory = arg;
    return index + 1;
  }
  throw new Error(`unexpected argument: ${arg}`);
}

function requireValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function parsePackageManager(value: string): PackageManager {
  if (PACKAGE_MANAGERS.has(value as PackageManager)) {
    return value as PackageManager;
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

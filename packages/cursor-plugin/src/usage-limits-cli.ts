#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const USAGE_URL = "https://cursor.com/api/usage-summary";
const MAX_RESPONSE_BYTES = 1024 * 1024;
const USER_ID_PATTERN = /user_[A-Za-z0-9_]+/;

interface CursorCredentials {
  userId: string;
  accessToken: string;
}

/** Finds Cursor CLI credentials in config documents and optional macOS Keychain token. */
export function findCredentials(
  documents: Record<string, unknown>[],
  keychainToken?: string,
): CursorCredentials | null {
  const rawUserId = firstAuthValue(documents, ["authId", "auth_id", "userId", "user_id"]);
  const accessToken =
    stringValue(keychainToken) ??
    firstAuthValue(documents, [
      "accessToken",
      "access_token",
      "access",
      "sessionToken",
      "session_token",
    ]);
  if (!rawUserId || !accessToken) return null;
  return { userId: rawUserId.match(USER_ID_PATTERN)?.[0] ?? rawUserId, accessToken };
}

async function main(): Promise<number> {
  const documents = configPaths().flatMap(readJson);
  const credentials = findCredentials(
    documents,
    process.platform === "darwin" ? readMacosKeychain("cursor-access-token") : undefined,
  );
  if (!credentials) {
    unavailable("Run `cursor-agent login` to load Cursor usage limits.");
    return 0;
  }

  try {
    const response = await fetch(USAGE_URL, {
      headers: {
        Accept: "application/json",
        Cookie: `WorkosCursorSessionToken=${encodeURIComponent(`${credentials.userId}::${credentials.accessToken}`)}`,
      },
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401 || response.status === 403) {
      unavailable("Cursor login expired. Run `cursor-agent login` again.");
      return 0;
    }
    if (!response.ok) {
      unavailable(
        "Cursor usage is temporarily unavailable. Pragma will retry automatically.",
        "unsupported",
      );
      return 0;
    }
    process.stdout.write(`${JSON.stringify(await readLimitedJson(response))}\n`);
    return 0;
  } catch {
    unavailable(
      "Cursor usage is temporarily unavailable. Pragma will retry automatically.",
      "unsupported",
    );
    return 0;
  }
}

function configPaths(): string[] {
  const home = homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME ?? join(home, ".config");
  return [
    join(home, ".cursor", "cli-config.json"),
    join(home, ".cursor", "auth.json"),
    join(xdgConfig, "cursor", "cli-config.json"),
    join(xdgConfig, "cursor", "auth.json"),
  ];
}

function readJson(path: string): Record<string, unknown>[] {
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isRecord(value) ? [value] : [];
  } catch {
    return [];
  }
}

function nestedAuthValues(value: Record<string, unknown>): Record<string, unknown>[] {
  const values = [value];
  for (const key of ["authInfo", "auth_info", "credentials", "oauth"]) {
    const nested = value[key];
    if (isRecord(nested)) values.push(nested);
  }
  return values;
}

function firstAuthValue(documents: Record<string, unknown>[], keys: string[]): string | undefined {
  for (const document of documents) {
    for (const container of nestedAuthValues(document)) {
      for (const key of keys) {
        const value = stringValue(container[key]);
        if (value) return value;
      }
    }
  }
  return undefined;
}

function readMacosKeychain(service: string): string | undefined {
  for (const args of [
    ["find-generic-password", "-s", service, "-a", "cursor-user", "-w"],
    ["find-generic-password", "-s", service, "-w"],
  ]) {
    const result = spawnSync("/usr/bin/security", args, { encoding: "utf8" });
    const token = result.status === 0 ? stringValue(result.stdout) : undefined;
    if (token) return token;
  }
  return undefined;
}

async function readLimitedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new Error("Cursor usage response had no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    // oxlint-disable-next-line no-await-in-loop -- one response stream must be read sequentially.
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      // oxlint-disable-next-line no-await-in-loop -- cancellation belongs to this sequential stream read.
      await reader.cancel();
      throw new Error("Cursor usage response exceeded size limit");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!isRecord(value)) throw new Error("Cursor usage response was not an object");
  return value;
}

function unavailable(
  message: string,
  reason: "authentication-required" | "unsupported" = "authentication-required",
): void {
  process.stdout.write(`${JSON.stringify({ status: "unavailable", reason, message })}\n`);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(resolve(entry)).href) {
  process.exitCode = await main();
}

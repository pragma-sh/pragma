/// <reference types="node" />
/* oxlint-disable no-await-in-loop -- retries are sequential by definition: each follows the failure it retries. */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Jev on OpenRouter: a routed model that reads text and images. */
const DEFAULT_MODEL = "typesafe/jev-router";
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1";
const REQUEST_TIMEOUT_MS = 120_000;

/** Raised when the model cannot be reached or answers with something unusable. */
class ModelError extends Error {
  override name = "ModelError";
}

/** Files searched, in order, for a key when none is in the environment. */
function keyFiles(): string[] {
  const explicit = process.env.JEV_ENV_FILE;
  return [
    ...(explicit ? [explicit] : []),
    join(homedir(), ".pragma", "jev.env"),
    join(homedir(), ".typesafe-computer-use", ".env"),
  ];
}

/** Parses `KEY=value` lines (with optional quotes), ignoring comments. */
export function parseEnvFile(contents: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    values[match[1]!] = match[2]!.replace(/^(['"])(.*)\1$/, "$2");
  }
  return values;
}

/**
 * Finds an OpenRouter key. `JEV_API_KEY` and `OPENROUTER_API_KEY` are read
 * from the environment first, then from the key files. A typesafe-computer-use
 * install keeps its OpenRouter key under `CLICKER_WRITER_API_KEY` or
 * `TYPESAFE_API_KEY`, so those count too when they hold an OpenRouter key.
 */
export function findApiKey(
  env: Record<string, string | undefined> = process.env,
  files: string[] = keyFiles(),
): string | null {
  const direct = env.JEV_API_KEY || env.OPENROUTER_API_KEY;
  if (direct) return direct;
  for (const file of files) {
    if (!existsSync(file)) continue;
    const values = parseEnvFile(readFileSync(file, "utf8"));
    const key = values.JEV_API_KEY || values.OPENROUTER_API_KEY;
    if (key) return key;
    const borrowed = [values.CLICKER_WRITER_API_KEY, values.TYPESAFE_API_KEY].find((value) =>
      value?.startsWith("sk-or-"),
    );
    if (borrowed) return borrowed;
  }
  return null;
}

/** A chat message; user content may mix text and images. */
export type ChatMessage =
  | { role: "system" | "assistant"; content: string }
  | {
      role: "user";
      content:
        | string
        | ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[];
    };

/** Builds a user message from text plus optional base64 PNGs. */
export function userMessage(text: string, images: string[] = []): ChatMessage {
  if (images.length === 0) return { role: "user", content: text };
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...images.map((data) => ({
        type: "image_url" as const,
        image_url: { url: `data:image/png;base64,${data}` },
      })),
    ],
  };
}

/** Extracts the first JSON object from a reply, tolerating code fences and chatter. */
export function parseJsonReply(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start)
    throw new ModelError(`model did not answer with JSON: ${text.slice(0, 300)}`);
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>;
  } catch {
    throw new ModelError(`model answered with malformed JSON: ${text.slice(0, 300)}`);
  }
}

interface ChatOptions {
  schema?: { name: string; schema: object };
  maxTokens?: number;
}

async function once(apiKey: string, body: object): Promise<Response> {
  return fetch(`${process.env.JEV_BASE_URL ?? DEFAULT_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/pragma-sh/pragma",
      "X-Title": "pragma-jev",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
}

/** Default output budget. Jev routes to reasoning models, which spend tokens thinking first. */
const DEFAULT_MAX_TOKENS = 6000;

async function complete(apiKey: string, body: Record<string, unknown>): Promise<Response> {
  let response: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      response = await once(apiKey, body);
      if (response.ok || (response.status !== 429 && response.status < 500)) return response;
    } catch (error) {
      if (attempt === 1)
        throw new ModelError(`could not reach the model: ${(error as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (!response) throw new ModelError("could not reach the model");
  return response;
}

interface Completion {
  choices?: { finish_reason?: string; message?: { content?: string | null } }[];
}

/**
 * One chat completion against Jev. Retries once on a network error, 429, or
 * 5xx, and once with double the budget when reasoning used it all up before
 * the model wrote an answer.
 */
export async function chat(messages: ChatMessage[], options: ChatOptions = {}): Promise<string> {
  const apiKey = findApiKey();
  if (!apiKey) {
    throw new ModelError(
      `no OpenRouter key: set JEV_API_KEY (or OPENROUTER_API_KEY), or put JEV_API_KEY=... in ${keyFiles().join(" or ")}`,
    );
  }
  const body: Record<string, unknown> = {
    model: process.env.JEV_MODEL ?? DEFAULT_MODEL,
    messages,
    temperature: 0,
    max_tokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
  };
  if (process.env.JEV_REASONING) body.reasoning = { effort: process.env.JEV_REASONING };
  if (options.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: options.schema.name, strict: true, schema: options.schema.schema },
    };
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const response = await complete(apiKey, body);
    if (!response.ok) {
      throw new ModelError(
        `model answered ${response.status}: ${(await response.text()).slice(0, 500)}`,
      );
    }
    const result = (await response.json()) as Completion;
    const choice = result.choices?.[0];
    const content = choice?.message?.content;
    if (content) return content;
    if (choice?.finish_reason !== "length" || attempt === 1) {
      throw new ModelError(`model returned no answer: ${JSON.stringify(result).slice(0, 300)}`);
    }
    body.max_tokens = Number(body.max_tokens) * 2;
  }
  throw new ModelError("model returned no answer");
}

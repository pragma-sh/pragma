import { constants } from "@pragma/constants";

import { isNumber, isString, matchesShape, nullable } from "./guards";

/** Managed metadata stored as one JSON line in scratchpad YAML frontmatter. */
export interface ScratchpadMetadata {
  version: number;
  id: string;
  title: string;
  agentTabId: string | null;
  agentId: string | null;
  createdAt: number;
}

/** Parsed managed scratchpad with its editable MDX body split from frontmatter. */
export interface ScratchpadDocument {
  metadata: ScratchpadMetadata;
  body: string;
  frontmatter: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

/**
 * Parses required managed frontmatter. MDX dropped into the scratchpad
 * directory by hand is rejected: without the managed line there is no id, no
 * title, and no agent attachment to edit.
 */
export function parseScratchpadDocument(source: string): ScratchpadDocument {
  const frontmatter = FRONTMATTER_PATTERN.exec(source);
  if (!frontmatter) {
    throw new Error("This MDX file is not a managed Pragma scratchpad.");
  }
  return {
    metadata: parseMetadata(metadataLine(frontmatter[1] ?? "")),
    body: source.slice(frontmatter[0].length),
    frontmatter: frontmatter[0],
  };
}

/** The one managed line inside a frontmatter block. */
function metadataLine(frontmatter: string): string {
  const key = constants.scratchpads.frontmatterKey;
  const line = frontmatter.split(/\r?\n/).find((entry) => entry.startsWith(`${key}: `));
  if (!line) throw new Error("Scratchpad frontmatter is missing managed metadata.");
  return line.slice(key.length + 2);
}

/** Parses that line, rejecting a contract version this build does not know. */
function parseMetadata(json: string): ScratchpadMetadata {
  const parsed: unknown = JSON.parse(json);
  if (!isScratchpadMetadata(parsed) || parsed.version !== constants.scratchpads.version) {
    throw new Error("Scratchpad metadata is invalid or uses an unsupported version.");
  }
  return parsed;
}

/** Replaces the MDX body while preserving every frontmatter byte. */
export function replaceScratchpadBody(document: ScratchpadDocument, body: string): string {
  return `${document.frontmatter}${body}`;
}

/** Updates the attached agent identity in managed frontmatter. */
export function attachScratchpadAgent(
  source: string,
  agent: { tabId: string; agentId: string },
): string {
  const document = parseScratchpadDocument(source);
  const metadata: ScratchpadMetadata = {
    ...document.metadata,
    agentTabId: agent.tabId,
    agentId: agent.agentId,
  };
  const key = constants.scratchpads.frontmatterKey;
  const nextLine = `${key}: ${JSON.stringify(metadata)}`;
  const lines = document.frontmatter.split(/\r?\n/);
  const index = lines.findIndex((line) => line.startsWith(`${key}: `));
  if (index < 0) throw new Error("Scratchpad frontmatter is missing managed metadata.");
  lines[index] = nextLine;
  return `${lines.join("\n")}${document.body}`;
}

function isScratchpadMetadata(value: unknown): value is ScratchpadMetadata {
  return matchesShape(value, {
    version: isNumber,
    id: isString,
    title: isString,
    agentTabId: nullable(isString),
    agentId: nullable(isString),
    createdAt: isNumber,
  });
}

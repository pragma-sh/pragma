import { constants } from "@pragma/constants";

/** Managed metadata stored as JSON in scratchpad YAML frontmatter. */
export interface ScratchpadMetadata {
  version: number;
  id: string;
  title: string;
  agentTabId: string | null;
  agentId: string | null;
  createdAt: number;
}

/** Parsed managed scratchpad with its editable MDX body separated from frontmatter. */
export interface ScratchpadDocument {
  metadata: ScratchpadMetadata;
  body: string;
  frontmatter: string;
}

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n)?/;

/** Parses required managed frontmatter. Manually dropped MDX without it is rejected. */
export function parseScratchpadDocument(source: string): ScratchpadDocument {
  const frontmatter = FRONTMATTER_PATTERN.exec(source);
  if (!frontmatter) {
    throw new Error("This MDX file is not a managed Pragma scratchpad.");
  }
  const key = constants.scratchpads.frontmatterKey;
  const line = frontmatter[1]?.split(/\r?\n/).find((entry) => entry.startsWith(`${key}: `));
  if (!line) {
    throw new Error("Scratchpad frontmatter is missing managed metadata.");
  }
  const parsed: unknown = JSON.parse(line.slice(key.length + 2));
  if (!isScratchpadMetadata(parsed) || parsed.version !== constants.scratchpads.version) {
    throw new Error("Scratchpad metadata is invalid or uses an unsupported version.");
  }
  return {
    metadata: parsed,
    body: source.slice(frontmatter[0].length),
    frontmatter: frontmatter[0],
  };
}

/** Replaces MDX body while preserving all frontmatter bytes. */
export function replaceScratchpadBody(document: ScratchpadDocument, body: string): string {
  return `${document.frontmatter}${body}`;
}

/** Updates attached agent identity in managed frontmatter. */
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

/** Sibling JSON path storing scratchpad comment threads. */
export function scratchpadCommentsPath(filePath: string): string {
  return `${filePath}.comments.json`;
}

function isScratchpadMetadata(value: unknown): value is ScratchpadMetadata {
  if (!value || typeof value !== "object") return false;
  const metadata = value as Record<string, unknown>;
  return (
    typeof metadata.version === "number" &&
    typeof metadata.id === "string" &&
    typeof metadata.title === "string" &&
    (typeof metadata.agentTabId === "string" || metadata.agentTabId === null) &&
    (typeof metadata.agentId === "string" || metadata.agentId === null) &&
    typeof metadata.createdAt === "number"
  );
}

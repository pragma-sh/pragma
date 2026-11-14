import type { AgentModelEntry, MarkdownSource } from "@pragma-sh/plugin/catalog";
import { createPiPragmaPlugin } from "@pragma-sh/pi-plugin/pragma-plugin-factory";

/** omp's `--thinking` levels, in its own order; `auto` lets omp pick per turn. */
const OMP_REASONING_NAMES: Record<string, string> = {
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/**
 * omp's markdown commands (`/<name>`) and skills (`/skill:<name>`). Unlike Pi,
 * native discovery is `.omp`-rooted; `.agents` is a portable provider omp
 * also scans.
 */
const OMP_SLASH_COMMAND_SOURCES: MarkdownSource[] = [
  { dir: ".omp/commands", layout: "files", recursive: false },
  { dir: ".agents/commands", layout: "files", recursive: false },
  { dir: "~/.omp/agent/commands", layout: "files", recursive: false },
  { dir: "~/.agents/commands", layout: "files", recursive: false },
  { dir: ".omp/skills", layout: "skills", prefix: "skill:" },
  { dir: ".agents/skills", layout: "skills", prefix: "skill:" },
  { dir: "~/.omp/agent/skills", layout: "skills", prefix: "skill:" },
  { dir: "~/.agents/skills", layout: "skills", prefix: "skill:" },
];

/** One row of `omp models --json`. */
interface OmpModelRow {
  provider?: unknown;
  kind?: unknown;
  selector?: unknown;
  id?: unknown;
  name?: unknown;
  reasoning?: unknown;
  thinking?: unknown;
}

/**
 * Parses `omp models --json` (`{ models: [...] }`) into launcher entries.
 * Ids are omp's exact `provider/model` selectors, which `--model` accepts
 * verbatim. Tolerates leading noise (an update banner) before the JSON body.
 */
export function parseOmpModels(output: string): AgentModelEntry[] {
  const start = output.indexOf("{");
  if (start < 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start));
  } catch {
    return [];
  }
  const rows = (parsed as { models?: unknown }).models;
  if (!Array.isArray(rows)) return [];
  return rows.flatMap((row: OmpModelRow) => {
    const entry = toModelEntry(row);
    return entry ? [entry] : [];
  });
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** omp's exact `--model` selector for a row, or its `provider/id` fallback. */
function modelSelector(row: OmpModelRow): string | undefined {
  const provider = optionalString(row.provider);
  const modelId = optionalString(row.id);
  return (
    optionalString(row.selector) ?? (provider && modelId ? `${provider}/${modelId}` : undefined)
  );
}

/** The reasoning levels a row advertises, or none when it does not reason. */
function reasoningLevels(row: OmpModelRow): string[] {
  if (row.reasoning !== true || !Array.isArray(row.thinking)) return [];
  return row.thinking.filter((level): level is string => typeof level === "string");
}

/** Converts one chat-model row to a launcher entry; skips other kinds. */
function toModelEntry(row: OmpModelRow): AgentModelEntry | undefined {
  if (row.kind !== undefined && row.kind !== "chat") return undefined;
  const selector = modelSelector(row);
  if (!selector) return undefined;
  const provider = optionalString(row.provider);
  const label = optionalString(row.name) ?? optionalString(row.id) ?? selector;
  const entry: AgentModelEntry = {
    id: selector,
    name: provider ? `${label} (${provider})` : label,
  };
  const levels = reasoningLevels(row);
  if (levels.length > 0) {
    entry.reasoning = levels.map((id) => ({ id, name: OMP_REASONING_NAMES[id] ?? id }));
  }
  return entry;
}

/** Pragma launcher and interjection watcher for Oh My Pi (`omp`). */
export const ompAgentPlugin = createPiPragmaPlugin({
  plugin: {
    name: "Oh My Pi",
    description: "Launch Oh My Pi (omp) from Pragma.",
  },
  agent: {
    id: "omp",
    name: "Oh My Pi",
    iconPath: "assets/omp-badge.svg",
    command: ["omp"],
    // `omp --resume <id>` reopens a session by id prefix or path (omp 18.18).
    resumeFlag: "--resume",
    // Resolved from PATH like the launch command itself; no shell or
    // install-path fallbacks.
    modelListCommand: "omp models --json 2>/dev/null",
    parseModels: parseOmpModels,
    watcher: {
      // omp steers the running turn with Enter while a response streams (Pi
      // queues a follow-up with Alt+Enter instead, which omp ignores).
      interjectSubmitKeys: "\x1b[13u",
      // `ask` has no answer-returning hook, so the watcher answers its native
      // form dialog: Down to the option, Space picks it, Enter moves to the
      // next field, and a final Enter on Submit sends the form. Free text goes
      // in the field's "Other" row, reached by moving past its options.
      handleQuestionAnswers: true,
      questionSelectMode: "arrow-space",
      questionOtherMode: "navigate",
      questionFinalizeKeys: "\r",
    },
    slashCommandSources: OMP_SLASH_COMMAND_SOURCES,
    excludeFeatures: ["commandApproval", "usageLimits"],
  },
});

export default ompAgentPlugin;

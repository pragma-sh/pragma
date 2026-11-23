import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import type {
  GlobalProjectScripts,
  GlobalScriptsConfig,
  GlobalWorktreeScripts,
  ProjectScriptsConfig,
} from "@pragma-sh/constants";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { readProjectScriptsFile, writeProjectScriptsFile } from "@/lib/tauri";

type WorktreeHook = "setup" | "teardown";
type ProjectHook = keyof GlobalProjectScripts;

/** Splits a textarea into commands: one per line, blank lines dropped. */
function commandsFromText(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/**
 * Global lifecycle scripts, stored under `scripts` in the global `config.json`.
 *
 * Worktree hooks layer on every project's own `.pragma/scripts.json`; project
 * hooks exist only here, so a repository's checked-in files never run code
 * just because it was added. Header run scripts carry split layouts and icons,
 * which a line list cannot express, so they are edited in the file itself.
 */
export function ScriptsSection({
  settings,
  persist,
}: {
  settings: GlobalScriptsConfig;
  persist: (next: GlobalScriptsConfig) => Promise<void>;
}) {
  const worktree = settings.worktree ?? {};
  const project = settings.project ?? {};
  const saveWorktree = (hook: WorktreeHook, commands: string[]) =>
    persist({ ...settings, worktree: withList<GlobalWorktreeScripts>(worktree, hook, commands) });
  const saveProject = (hook: ProjectHook, commands: string[]) =>
    persist({ ...settings, project: withList<GlobalProjectScripts>(project, hook, commands) });
  const runScriptNames = Object.keys(worktree.runScripts ?? {}).toSorted();

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Worktree scripts"
        description="Run for every worktree in every project, on top of the project's own .pragma/scripts.json. One command per line; the commands in a list run concurrently."
      >
        <div className="space-y-4">
          <CommandList
            id="scripts-worktree-setup"
            label="Setup"
            hint="After a worktree is created, from its root — before the project's own setup."
            commands={worktree.setup}
            onSave={(commands) => saveWorktree("setup", commands)}
          />
          <CommandList
            id="scripts-worktree-teardown"
            label="Teardown"
            hint="Before a worktree is deleted, after the project's own teardown. A failure blocks the deletion."
            commands={worktree.teardown}
            onSave={(commands) => saveWorktree("teardown", commands)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Project scripts"
        description="Run from the project root. These live only in your global config: a cloned repository can never trigger them."
      >
        <div className="space-y-4">
          <CommandList
            id="scripts-project-add"
            label="Add"
            hint="After a project is added, cloned, or connected over SSH."
            commands={project.add}
            onSave={(commands) => saveProject("add", commands)}
          />
          <CommandList
            id="scripts-project-remove"
            label="Remove"
            hint="Before a project is removed from Pragma (its files are kept). A failure asks before removing anyway."
            commands={project.remove}
            onSave={(commands) => saveProject("remove", commands)}
          />
          <CommandList
            id="scripts-project-switch"
            label="Switch"
            hint="In the background when you switch to a project from another one. Opening Pragma is not a switch."
            commands={project.switch}
            onSave={(commands) => saveProject("switch", commands)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Header scripts"
        description="Buttons offered in every project's header, edited under scripts.worktree.runScripts in config.json. A project script with the same name wins."
      >
        <RunScriptNames names={runScriptNames} />
      </SettingsCard>

      <p className="text-xs text-muted-foreground">
        Scripts are read from the home directory of the machine a project lives on. An SSH project
        uses the remote machine's ~/.pragma/config.json, not this one.
      </p>
    </div>
  );
}

/** The project's file as Settings reads it: parsed, or why it could not be. */
type LoadedProjectScripts =
  | { status: "loading" }
  | { status: "ready"; config: ProjectScriptsConfig; path: string }
  | { status: "error"; error: string };

/**
 * A project's own `.pragma/scripts.json` lifecycle lists, edited in place.
 *
 * Only `setup` and `teardown` are line lists Settings can edit; everything
 * else in the file — `runScripts` with their split layouts and icons — is
 * kept exactly as written. The host validates each write with the parser it
 * runs scripts through, so a save can never leave a file every worktree
 * creation then fails on. Project lifecycle hooks (`add`/`remove`/`switch`)
 * are deliberately absent: a checked-in file must never run code merely
 * because the project was added.
 */
export function ProjectScriptsSection({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string | null;
}) {
  const [loaded, setLoaded] = useState<LoadedProjectScripts>({ status: "loading" });
  // Bumped whenever the project changes (and by each reload), so a read or
  // write that finishes for an earlier request can tell it is stale.
  const generation = useRef(0);
  // The document as edits have left it, ahead of what a pending write has
  // confirmed: each save builds on this, so back-to-back edits to different
  // lists never overwrite one another.
  const current = useRef<{ config: ProjectScriptsConfig; path: string } | null>(null);
  // Writes run one at a time, in the order they were made.
  const writeQueue = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(async () => {
    generation.current += 1;
    const mine = generation.current;
    try {
      const document = await readProjectScriptsFile(projectId);
      if (mine !== generation.current) return;
      const config = parseProjectScripts(document.contents);
      current.current = { config, path: document.path };
      setLoaded({ status: "ready", config, path: document.path });
    } catch (cause) {
      if (mine !== generation.current) return;
      current.current = null;
      setLoaded({ status: "error", error: errorMessage(cause) });
    }
  }, [projectId]);

  useEffect(() => {
    current.current = null;
    setLoaded({ status: "loading" });
    void load();
    return () => {
      // Invalidate anything still in flight for this project.
      generation.current += 1;
    };
  }, [load]);

  if (loaded.status === "loading") {
    return <p className="text-sm text-muted-foreground">Loading scripts…</p>;
  }
  if (loaded.status === "error") {
    return (
      <SettingsCard title="scripts.json needs attention">
        <p className="text-sm text-destructive">{loaded.error}</p>
        <Button className="mt-4" variant="ghost" onClick={() => void load()}>
          <RefreshCw /> Reload
        </Button>
      </SettingsCard>
    );
  }

  const { config, path } = loaded;
  const save = async (hook: WorktreeHook, commands: string[]) => {
    const base = current.current;
    if (!base) return;
    const mine = generation.current;
    const next = withList<ProjectScriptsConfig>(base.config, hook, commands);
    current.current = { ...base, config: next };
    setLoaded({ status: "ready", config: next, path: base.path });
    const contents = `${JSON.stringify(next, null, 2)}\n`;
    const write = writeQueue.current.then(() => writeProjectScriptsFile(projectId, contents));
    writeQueue.current = write.catch(() => undefined);
    try {
      await write;
    } catch (cause) {
      toast.error("Could not save scripts.json", { description: errorMessage(cause) });
      // Resync with the file, unless the project changed meanwhile.
      if (mine === generation.current) void load();
    }
  };

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Worktree scripts"
        description={`Checked into ${projectName ?? "this project"} at .pragma/scripts.json, so everyone who opens it runs them. They run after your global worktree scripts. One command per line; the commands in a list run concurrently.`}
      >
        <div className="space-y-4">
          <CommandList
            id="project-scripts-setup"
            label="Setup"
            hint="After a worktree is created, from its root — after your global setup."
            commands={config.setup}
            onSave={(commands) => save("setup", commands)}
          />
          <CommandList
            id="project-scripts-teardown"
            label="Teardown"
            hint="Before a worktree is deleted, before your global teardown. A failure blocks the deletion."
            commands={config.teardown}
            onSave={(commands) => save("teardown", commands)}
          />
        </div>
      </SettingsCard>

      <SettingsCard
        title="Header scripts"
        description="This project's header buttons, edited under runScripts in .pragma/scripts.json. One here wins over a global script with the same name."
      >
        <RunScriptNames names={Object.keys(config.runScripts ?? {}).toSorted()} />
      </SettingsCard>

      <p className="text-xs text-muted-foreground">
        Project add, remove, and switch scripts are global-only, so a repository can never run code
        just because it was added. Set them in the Global scope. Editing {path}.
      </p>
    </div>
  );
}

/** Parses a `.pragma/scripts.json` body, which must be a JSON object. */
function parseProjectScripts(contents: string): ProjectScriptsConfig {
  const value = JSON.parse(contents) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("scripts.json must contain a JSON object");
  }
  return value as ProjectScriptsConfig;
}

function RunScriptNames({ names }: { names: string[] }) {
  if (names.length === 0) {
    return <p className="text-sm text-muted-foreground">No header scripts.</p>;
  }
  return (
    <ul className="flex flex-wrap gap-2 text-sm">
      {names.map((name) => (
        <li key={name} className="rounded-md border px-2 py-0.5 font-mono">
          {name}
        </li>
      ))}
    </ul>
  );
}

/** Replaces one hook's list, dropping the key when it becomes empty. */
function withList<T extends object>(block: T, key: keyof T, commands: string[]): T {
  const next = { ...block };
  if (commands.length > 0) {
    (next as Record<keyof T, unknown>)[key] = commands;
  } else {
    delete next[key];
  }
  return next;
}

function CommandList({
  id,
  label,
  hint,
  commands,
  onSave,
}: {
  id: string;
  label: string;
  hint: string;
  commands: string[] | undefined;
  onSave: (commands: string[]) => Promise<void>;
}) {
  const saved = (commands ?? []).join("\n");
  const [draft, setDraft] = useState(saved);
  useEffect(() => setDraft(saved), [saved]);

  return (
    <label className="block text-sm" htmlFor={id}>
      <span className="font-medium">{label}</span>
      <span className="ml-2 text-muted-foreground">{hint}</span>
      <Textarea
        autoCapitalize="off"
        autoCorrect="off"
        className="mt-1.5 min-h-16 font-mono text-xs"
        id={id}
        placeholder="One command per line"
        spellCheck={false}
        value={draft}
        onBlur={() => {
          const next = commandsFromText(draft);
          if (next.join("\n") === saved) return;
          void onSave(next);
        }}
        onChange={(event) => setDraft(event.target.value)}
      />
    </label>
  );
}

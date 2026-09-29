import { useCallback, useEffect, useState } from "react";

import { Loader2 } from "lucide-react";
import { toast } from "sonner";

import type { System1Settings } from "@pragma-sh/constants";

import { System1ConnectionForm } from "@/components/ai/System1ConnectionForm";
import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { errorMessage } from "@/lib/errors";
import { AUTO_MODE_TEMPLATE } from "@/lib/system1-settings";
import { readAutoMode, writeAutoMode, type ConfigScope } from "@/lib/tauri";

/**
 * The System 1 half of Settings → AI. Global scope configures the connection
 * (base URL + key) and the global `automode.md`; project scope edits that
 * project's `automode.md`, which wins over the global one.
 */
export function System1Section({
  scope,
  projectId,
  projectName,
  saveSettings,
}: {
  scope: ConfigScope;
  projectId: string | null;
  projectName: string | null;
  saveSettings: (patch: System1Settings) => Promise<void>;
}) {
  return (
    <div className="space-y-5">
      {scope === "global" ? (
        <SettingsCard
          title="System 1 model"
          description="A fast classifier (TypeSafe Jev, or any Jev-compatible API) that powers Auto in every agent picker: it reads your prompt, the benchmarks, and your preferences, then picks an agent, a model, and a reasoning effort in well under a second. The key is stored in an owner-only file, like the GitHub token."
        >
          <System1ConnectionForm saveSettings={saveSettings} />
        </SettingsCard>
      ) : null}
      <AutoModeEditor projectId={projectId} projectName={projectName} scope={scope} />
    </div>
  );
}

/** Where one scope's `automode.md` stands: loading, failed, or loaded. */
type AutoModeDocument =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "loaded"; path: string; saved: string };

/** Loads and saves one scope's `automode.md`, tracking the draft separately. */
function useAutoModeDocument(scope: ConfigScope, projectId: string | null) {
  const [document, setDocument] = useState<AutoModeDocument>({ kind: "loading" });
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setDocument({ kind: "loading" });
    try {
      const file = await readAutoMode(scope, projectId);
      setDocument({ kind: "loaded", path: file.path, saved: file.contents });
      setDraft(file.contents);
    } catch (cause) {
      setDocument({ kind: "error", message: errorMessage(cause) });
    }
  }, [projectId, scope]);

  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    if (document.kind !== "loaded") return;
    setSaving(true);
    try {
      await writeAutoMode(scope, draft, projectId);
      setDocument({ ...document, saved: draft });
      toast.success("Auto mode preferences saved");
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  return { document, draft, setDraft, saving, load, save };
}

const AUTO_MODE_COPY: Record<ConfigScope, string> = {
  project: "This project's automode.md. Its filters and notes win over the global file.",
  global:
    "Your global automode.md. Frontmatter include/exclude lists are enforced before the System 1 model is asked; the text below it is passed to the model as your priorities. A project can override it from the project scope.",
};

/** Loads, edits, and saves one scope's `automode.md`. */
function AutoModeEditor({
  scope,
  projectId,
  projectName,
}: {
  scope: ConfigScope;
  projectId: string | null;
  projectName: string | null;
}) {
  const editor = useAutoModeDocument(scope, projectId);
  const title = scope === "project" ? `Auto mode — ${projectName ?? "this project"}` : "Auto mode";
  return (
    <SettingsCard title={title} description={AUTO_MODE_COPY[scope]}>
      <AutoModeBody editor={editor} />
    </SettingsCard>
  );
}

function AutoModeBody({ editor }: { editor: ReturnType<typeof useAutoModeDocument> }) {
  const { document, draft, setDraft } = editor;
  if (document.kind === "error") {
    return (
      <div className="flex items-center gap-3 text-sm text-destructive">
        {document.message}
        <Button size="sm" variant="outline" onClick={() => void editor.load()}>
          Retry
        </Button>
      </div>
    );
  }
  if (document.kind === "loading") {
    return <p className="text-sm text-muted-foreground">Loading…</p>;
  }
  return (
    <div className="space-y-3">
      <p className="font-mono text-xs break-all text-muted-foreground">{document.path}</p>
      <Textarea
        aria-label="automode.md"
        className="max-h-[28rem] min-h-64 font-mono text-xs"
        placeholder="No automode.md yet — start from the template."
        spellCheck={false}
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
      />
      <AutoModeActions
        dirty={draft !== document.saved}
        empty={draft.trim() === ""}
        saving={editor.saving}
        onDiscard={() => setDraft(document.saved)}
        onSave={() => void editor.save()}
        onTemplate={() => setDraft(AUTO_MODE_TEMPLATE)}
      />
    </div>
  );
}

function AutoModeActions({
  dirty,
  empty,
  saving,
  onDiscard,
  onSave,
  onTemplate,
}: {
  dirty: boolean;
  empty: boolean;
  saving: boolean;
  onDiscard: () => void;
  onSave: () => void;
  onTemplate: () => void;
}) {
  return (
    <div className="flex items-center gap-2">
      <Button disabled={saving || !dirty} size="sm" onClick={onSave}>
        {saving ? <Loader2 className="animate-spin" /> : null}
        Save
      </Button>
      {empty ? (
        <Button size="sm" variant="outline" onClick={onTemplate}>
          Start from template
        </Button>
      ) : null}
      {dirty ? (
        <Button size="sm" variant="ghost" onClick={onDiscard}>
          Discard changes
        </Button>
      ) : null}
    </div>
  );
}

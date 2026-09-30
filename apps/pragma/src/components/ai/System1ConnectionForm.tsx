import { useEffect, useId, useState } from "react";

import { Check, ExternalLink, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { constants, type System1Settings } from "@pragma-sh/constants";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { errorMessage } from "@/lib/errors";
import { openExternal } from "@/lib/open-external";
import { defaultSystem1Model } from "@/lib/system1-settings";
import { system1Check, system1ClearApiKey, system1SetApiKey, system1Status } from "@/lib/tauri";
import { setSystem1Status, useSystem1Status } from "@/state/system1";

/** Where to get a Jev key; shown next to the key field. */
const JEV_CONSOLE_URL = "https://console.typesafe.ai";
const DEFAULT_URL = constants.system1.defaultBaseUrl;

type Busy = "test" | "save" | "remove" | null;

/** Form state plus the three actions, kept out of the markup. */
function useSystem1Form(
  saveSettings: (patch: System1Settings) => Promise<void>,
  onSaved: (() => void) | undefined,
) {
  const status = useSystem1Status();
  const [baseUrl, setBaseUrl] = useState("");
  const [model, setModel] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState<Busy>(null);

  // Prefill only what the user set: a default URL or a host-default model
  // stays blank so it keeps tracking the shipped default.
  useEffect(() => {
    if (!status) return;
    if (status.baseUrl !== DEFAULT_URL) setBaseUrl(status.baseUrl);
    if (status.model !== defaultSystem1Model(status.baseUrl)) setModel(status.model);
  }, [status]);

  const configured = status?.configured === true;
  const draftUrl = baseUrl.trim() || undefined;
  const draftModel = model.trim() || undefined;
  const draftKey = apiKey.trim();

  async function run(kind: Exclude<Busy, null>, action: () => Promise<void>) {
    setBusy(kind);
    try {
      await action();
    } catch (cause) {
      toast.error(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  }

  const test = () =>
    run("test", async () => {
      const answered = await system1Check({
        baseUrl: draftUrl ?? DEFAULT_URL,
        ...(draftKey ? { apiKey: draftKey } : {}),
        ...(draftModel ? { model: draftModel } : {}),
      });
      toast.success(answered ? `Connected — ${answered} answered.` : "Connected.");
    });

  const save = () =>
    run("save", async () => {
      await saveSettings({
        baseUrl: draftUrl === DEFAULT_URL ? undefined : draftUrl,
        model: draftModel,
      });
      // Refresh the shared status on every save: a URL or model change with no
      // new key must still update what Auto (and a reopened form) reads.
      setSystem1Status(draftKey ? await system1SetApiKey(draftKey) : await system1Status());
      if (draftKey) setApiKey("");
      toast.success("System 1 model saved");
      onSaved?.();
    });

  const remove = () =>
    run("remove", async () => {
      setSystem1Status(await system1ClearApiKey());
      toast.success("System 1 key removed");
    });

  return {
    baseUrl,
    setBaseUrl,
    model,
    setModel,
    apiKey,
    setApiKey,
    busy,
    configured,
    // Testing or saving needs a key: a draft one, or the stored one.
    ready: busy === null && (draftKey.length > 0 || configured),
    test,
    save,
    remove,
  };
}

/**
 * Base URL + API key for a System 1 model (Jev or a Jev-compatible API), with
 * Test / Save / Remove. The key goes straight to the owner-only credential
 * file and is never read back; the base URL and model are global settings
 * persisted by `saveSettings` (Settings' queued writer, or a direct patch in
 * onboarding).
 *
 * The URL may be an origin (`https://api.typesafe.ai`) or a full endpoint
 * (`https://openrouter.ai/api/alpha/decisions`). A blank model follows the
 * host: OpenRouter gets `~typesafe/jev-latest`, anything else `jev-latest`.
 */
export function System1ConnectionForm({
  saveSettings,
  onSaved,
}: {
  /** Persists the `system1` block; an `undefined` field restores its default. */
  saveSettings: (patch: System1Settings) => Promise<void>;
  onSaved?: () => void;
}) {
  const form = useSystem1Form(saveSettings, onSaved);
  return (
    <div className="flex w-full flex-col gap-3">
      <BaseUrlField value={form.baseUrl} onChange={form.setBaseUrl} />
      <ModelField
        placeholder={defaultSystem1Model(form.baseUrl.trim() || DEFAULT_URL)}
        value={form.model}
        onChange={form.setModel}
      />
      <ApiKeyField configured={form.configured} value={form.apiKey} onChange={form.setApiKey} />
      <div className="flex flex-wrap items-center gap-2">
        <Button disabled={!form.ready} size="sm" type="button" onClick={() => void form.save()}>
          {form.busy === "save" ? <Loader2 className="animate-spin" /> : null}
          Save
        </Button>
        <Button
          disabled={!form.ready}
          size="sm"
          type="button"
          variant="outline"
          onClick={() => void form.test()}
        >
          {form.busy === "test" ? <Loader2 className="animate-spin" /> : null}
          Test connection
        </Button>
        {form.configured ? (
          <StoredKeyActions disabled={form.busy !== null} onRemove={() => void form.remove()} />
        ) : null}
      </div>
    </div>
  );
}

function BaseUrlField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Base URL or endpoint</Label>
      <Input
        id={id}
        placeholder={DEFAULT_URL}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ModelField({
  placeholder,
  value,
  onChange,
}: {
  /** The model a blank field resolves to for the current URL. */
  placeholder: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>Model</Label>
      <Input
        id={id}
        placeholder={placeholder}
        spellCheck={false}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ApiKeyField({
  configured,
  value,
  onChange,
}: {
  configured: boolean;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label htmlFor={id}>API key</Label>
        <Button
          className="h-auto p-0 text-xs text-muted-foreground"
          type="button"
          variant="link"
          onClick={() => void openExternal(JEV_CONSOLE_URL)}
        >
          Get a Jev key <ExternalLink className="size-3" />
        </Button>
      </div>
      <Input
        autoComplete="off"
        id={id}
        placeholder={configured ? "Saved — enter a new key to replace it" : "Paste your API key"}
        spellCheck={false}
        type="password"
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function StoredKeyActions({ disabled, onRemove }: { disabled: boolean; onRemove: () => void }) {
  return (
    <>
      <Button disabled={disabled} size="sm" type="button" variant="ghost" onClick={onRemove}>
        Remove key
      </Button>
      <span className="ml-auto flex items-center gap-1 text-xs text-muted-foreground">
        <Check className="size-3.5 text-primary" /> Key saved
      </span>
    </>
  );
}

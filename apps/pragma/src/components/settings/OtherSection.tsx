import { useEffect, useState } from "react";
import { constants, type OtherSettings } from "@pragma/constants";
import { toast } from "sonner";

import { SettingsCard } from "@/components/settings/SettingsCard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { useUpdates } from "@/state/updates-context";

/**
 * Global-only update preferences: check URL override and auto-download.
 * Running versions are read-only from the native runtime.
 */
export function OtherSection({
  persist,
  settings,
}: {
  settings: OtherSettings;
  persist: (patch: OtherSettings) => Promise<void>;
}) {
  const { runtime, offer, checking, checkNow } = useUpdates();
  const defaultUrl = runtime?.checkUrl ?? constants.updates.devCheckUrl;
  const serverUrl = settings.serverUrl ?? "";
  const autoDownload = settings.autoDownload ?? constants.updates.autoDownload;
  const [draftUrl, setDraftUrl] = useState(serverUrl);

  useEffect(() => {
    setDraftUrl(serverUrl);
  }, [serverUrl]);

  return (
    <div className="space-y-5">
      <SettingsCard
        title="Update server"
        description="Dev builds poll the local docs server. Production polls pragma-app.sh. Forks can point this at their own endpoint."
      >
        <label className="block text-sm" htmlFor="other-server-url">
          Server URL
          <Input
            className="mt-1.5"
            id="other-server-url"
            placeholder={defaultUrl}
            value={draftUrl}
            onBlur={() => {
              const next = draftUrl.trim();
              if (next === serverUrl) return;
              void persist({ serverUrl: next || undefined });
            }}
            onChange={(event) => setDraftUrl(event.target.value)}
          />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setDraftUrl("");
              void persist({ serverUrl: undefined });
            }}
          >
            Reset to default
          </Button>
          <Button
            disabled={checking}
            size="sm"
            onClick={() => {
              void checkNow().then(() => toast.success("Checked for updates"));
            }}
          >
            Check now
          </Button>
        </div>
      </SettingsCard>

      <SettingsCard
        title="Download"
        description="When on, Pragma polls on launch and on an interval. When off, only Check now runs."
      >
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm" htmlFor="other-auto-download">
            Auto-download
          </label>
          <Switch
            checked={autoDownload}
            id="other-auto-download"
            onCheckedChange={(checked) => void persist({ autoDownload: checked })}
          />
        </div>
      </SettingsCard>

      <SettingsCard title="This install" description="Versions this process reports on a check.">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <VersionRow label="UI" value={runtime?.versions.ui} />
          <VersionRow label="App" value={runtime?.versions.app} />
          <VersionRow label="Server" value={runtime?.versions.server} />
          <VersionRow label="Protocol" value={runtime?.versions.protocol} />
          <VersionRow label="Platform" value={runtime?.platform} />
        </dl>
        {offer?.available ? (
          <p className="mt-3 text-sm text-muted-foreground">
            {offer.notes}{" "}
            {offer.changelogUrl ? (
              <a
                className="text-primary underline-offset-4 hover:underline"
                href={offer.changelogUrl}
                rel="noreferrer"
                target="_blank"
              >
                {constants.updates.changelogLabel}
              </a>
            ) : null}
          </p>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">No update waiting.</p>
        )}
      </SettingsCard>
    </div>
  );
}

function VersionRow({ label, value }: { label: string; value: string | undefined }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="font-mono">{value ?? "…"}</dd>
    </>
  );
}

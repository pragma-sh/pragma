import { useEffect, useRef } from "react";
import { toast } from "sonner";
import type { StorageReminderSettings } from "@pragma-sh/constants";

import { formatLocalDate, reminderOwed } from "@/lib/storage-reminder";
import { readConfig } from "@/lib/tauri";
import { useKanban } from "@/state/kanban-context";

/** Which reminder occurrence this machine last dismissed. Cosmetic, per install. */
const ACK_KEY = "pragma.storageReminder.acknowledged";
/** How often an open window re-checks whether a reminder has come due. */
const CHECK_INTERVAL_MS = 60 * 60 * 1000;

function readAck(): string | null {
  try {
    return window.localStorage.getItem(ACK_KEY);
  } catch {
    return null;
  }
}

function writeAck(date: string): void {
  try {
    window.localStorage.setItem(ACK_KEY, date);
  } catch {
    // Storage unavailable: the reminder simply shows again next launch.
  }
}

async function loadReminder(): Promise<StorageReminderSettings | undefined> {
  const document = await readConfig("global", null);
  if (!document.exists) return undefined;
  const config = JSON.parse(document.contents) as { storage?: { reminder?: unknown } };
  const reminder = config.storage?.reminder;
  return reminder && typeof reminder === "object"
    ? (reminder as StorageReminderSettings)
    : undefined;
}

/**
 * Raises the storage reminder configured in Settings → Storage when one comes
 * due: at launch, hourly, and whenever the window becomes visible. Renders
 * nothing. A reminder stays until acted on or dismissed, and each occurrence
 * is shown once.
 */
export function StorageReminderWatcher() {
  const { openSettings } = useKanban();
  const settings = useRef<StorageReminderSettings | undefined>(undefined);
  const shown = useRef<string | null>(null);

  useEffect(() => {
    let live = true;

    const check = () => {
      const due = reminderOwed(settings.current, readAck(), new Date());
      if (!due) return;
      const occurrence = formatLocalDate(due);
      if (shown.current === occurrence) return;
      shown.current = occurrence;
      const acknowledge = () => writeAck(occurrence);
      toast("Time to review storage", {
        description: "See what your projects use on disk and free up space.",
        duration: Infinity,
        action: {
          label: "Open Storage",
          onClick: () => {
            acknowledge();
            openSettings("storage");
          },
        },
        onDismiss: acknowledge,
      });
    };

    const reload = async () => {
      try {
        const next = await loadReminder();
        if (!live) return;
        settings.current = next;
        check();
      } catch {
        // A malformed config is reported by Settings itself; stay quiet here.
      }
    };
    const onConfigChanged = () => void reload();

    const onVisible = () => {
      if (document.visibilityState === "visible") check();
    };

    void reload();
    const timer = window.setInterval(check, CHECK_INTERVAL_MS);
    window.addEventListener("pragma:config-changed", onConfigChanged);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      live = false;
      window.clearInterval(timer);
      window.removeEventListener("pragma:config-changed", onConfigChanged);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [openSettings]);

  return null;
}

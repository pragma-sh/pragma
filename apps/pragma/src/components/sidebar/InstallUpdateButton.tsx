import { constants } from "@pragma/constants";

import { Button } from "@/components/ui/button";
import { useUpdates } from "@/state/updates-context";

/** Sidebar control that applies a checked update. Hidden when nothing is waiting. */
export function InstallUpdateButton({ compact = false }: { compact?: boolean }) {
  const { offer, applying, install } = useUpdates();
  if (!offer?.available) return null;
  if (compact) {
    return (
      <Button
        aria-label={constants.updates.buttonLabel}
        className="relative"
        disabled={applying}
        size="icon-sm"
        variant="default"
        onClick={() => void install()}
      >
        <span className="bg-primary-foreground size-2 rounded-full" />
      </Button>
    );
  }
  return (
    <Button className="mb-2 w-full" disabled={applying} size="sm" onClick={() => void install()}>
      {constants.updates.buttonLabel}
    </Button>
  );
}

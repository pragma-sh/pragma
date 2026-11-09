import type { ComputerPermissionKind, ComputerPermissions } from "@pragma-sh/constants";

import { Button } from "@/components/ui/button";

const PERMISSIONS = [
  { kind: "accessibility", label: "Accessibility", description: "Read and control apps." },
  { kind: "screenRecording", label: "Screen Recording", description: "See what is on screen." },
] as const;

/** The same two macOS permission controls in Settings and the first-use popup. */
export function ComputerPermissionControls({
  permissions,
  requesting,
  request,
}: {
  permissions: ComputerPermissions;
  requesting: ComputerPermissionKind | null;
  request: (permission: ComputerPermissionKind) => Promise<void>;
}) {
  return (
    <div className="flex flex-col gap-4">
      {PERMISSIONS.map(({ kind, label, description }) => {
        const granted = permissions[kind] === "granted";
        return (
          <div className="flex flex-wrap items-center justify-between gap-2" key={kind}>
            <div>
              <p className="text-sm font-medium">{label}</p>
              <p className="text-xs text-muted-foreground">{description}</p>
            </div>
            <Button
              disabled={granted || requesting !== null}
              onClick={() => void request(kind)}
              size="sm"
              variant="outline"
            >
              {granted ? `${label} enabled` : `Allow ${label}`}
            </Button>
          </div>
        );
      })}
    </div>
  );
}

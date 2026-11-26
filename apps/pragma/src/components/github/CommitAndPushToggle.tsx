import { useId } from "react";

import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";

/**
 * The "Commit and push" switch shared by the review fix dialogs: when on, the
 * fix prompt asks the agent to commit its changes and push the current branch.
 */
export function CommitAndPushToggle({
  checked,
  onCheckedChange,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-canvas px-3 py-2">
      <div className="space-y-0.5">
        <Label htmlFor={id}>Commit and push</Label>
        <p className="text-xs text-muted-foreground">
          Ask agent to commit resulting changes and push current branch.
        </p>
      </div>
      <Switch checked={checked} id={id} onCheckedChange={onCheckedChange} />
    </div>
  );
}

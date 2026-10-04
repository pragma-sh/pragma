import { SettingsCard } from "@/components/settings/SettingsCard";
import { Switch } from "@/components/ui/switch";
import { setCompactWorktreeRows, useCompactWorktreeRows } from "@/state/sidebar-preferences";

/**
 * Project sidebar layout. Cosmetic and per-device, so it reads and writes
 * `state/sidebar-preferences` (localStorage), not `config.json`.
 */
export function SidebarSection() {
  const compact = useCompactWorktreeRows();
  return (
    <div className="space-y-5">
      <SettingsCard
        title="Worktree rows"
        description="Detailed rows list a worktree's open pull request, any git action in progress, and one line per agent under its title. Compact rows show only the title line; nesting and the status dot stay the same."
      >
        <div className="flex items-center justify-between gap-4">
          <label className="text-sm" htmlFor="sidebar-compact-rows">
            Compact rows
          </label>
          <Switch
            checked={compact}
            id="sidebar-compact-rows"
            onCheckedChange={setCompactWorktreeRows}
          />
        </div>
      </SettingsCard>
    </div>
  );
}

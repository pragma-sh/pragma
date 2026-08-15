import { Plus, X } from "lucide-react";
import { useState } from "react";
import { constants } from "@pragma/constants";

import { AgentModelSelector } from "@/components/agents/AgentModelSelector";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { AgentSelection } from "@/hooks/use-agent-selection";
import type { AgentModelSelection } from "@/lib/tauri";

/** One requested attempt in the create dialog's fanout mode. */
export interface FanoutRow {
  /** Stable across reorder/duplicate so React keeps each picker's state. */
  key: string;
  agentId: string | null;
  selection: AgentModelSelection;
}

/** A fresh row seeded from the dialog's single-agent selection. */
export function newFanoutRow(agentId: string | null, selection: AgentModelSelection): FanoutRow {
  return { key: crypto.randomUUID(), agentId, selection };
}

/** Fewest attempts a fanout may have, from the shared contract. There is no ceiling. */
const MIN_FANOUT_ROWS = constants.fanout.minMembers;

interface FanoutRowsProps {
  rows: FanoutRow[];
  onChange: (rows: FanoutRow[]) => void;
  selection: AgentSelection;
}

/**
 * The repeatable agent picker list for fanout mode.
 *
 * Each row is the same {@link AgentModelSelector} the single-agent path uses —
 * unchanged, not a fanout-specific variant — so a selection means exactly what
 * it does everywhere else. Duplicates are allowed on purpose: sampling one model
 * twice is a supported use.
 */
export function FanoutRows({ rows, onChange, selection }: FanoutRowsProps) {
  return (
    <div className="space-y-2">
      <Label>Attempts</Label>
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <AgentModelSelector
              agents={selection.agents}
              modelsByAgent={selection.modelsByAgent}
              value={{ agentId: row.agentId, selection: row.selection }}
              onChange={(agentId, next) =>
                onChange(
                  rows.map((candidate) =>
                    candidate.key === row.key
                      ? { ...candidate, agentId, selection: next }
                      : candidate,
                  ),
                )
              }
              onLoadModels={selection.loadModels}
            />
          </div>
          <IconButton
            disabled={rows.length <= MIN_FANOUT_ROWS}
            label="Remove attempt"
            size="icon"
            type="button"
            variant="ghost"
            onClick={() => onChange(rows.filter((candidate) => candidate.key !== row.key))}
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      ))}
      <Button
        size="sm"
        type="button"
        variant="outline"
        onClick={() =>
          onChange([
            ...rows,
            newFanoutRow(rows.at(-1)?.agentId ?? null, { modelId: null, reasoningId: null }),
          ])
        }
      >
        <Plus className="size-3.5" />
        Add agent
      </Button>
    </div>
  );
}

/** Everything the create dialog needs to run its fanout mode. */
export interface FanoutMode {
  mode: "single" | "fanout";
  isFanout: boolean;
  /**
   * Switches modes, seeding the first attempt row from the single-agent
   * selection so the switch never costs the user their work.
   */
  switchMode: (next: "single" | "fanout", seed: FanoutRow) => void;
  rows: FanoutRow[];
  setRows: (rows: FanoutRow[]) => void;
  /** True when the fanout form is complete enough to submit. */
  ready: (prompt: string, branch: string) => boolean;
}

/** Fanout-mode state for the create dialog. */
export function useFanoutMode(): FanoutMode {
  const [mode, setMode] = useState<"single" | "fanout">("single");
  const [rows, setRows] = useState<FanoutRow[]>([]);
  return {
    mode,
    isFanout: mode === "fanout",
    switchMode: (next, seed) => {
      setMode(next);
      if (next === "fanout" && rows.length === 0) {
        setRows([seed, newFanoutRow(seed.agentId, { modelId: null, reasoningId: null })]);
      }
    },
    rows,
    setRows,
    // Every fanout branches a fresh coordination parent, so the branch name is
    // always required — same as the single-worktree path.
    ready: (prompt, branch) =>
      prompt.trim().length > 0 && rows.length >= MIN_FANOUT_ROWS && branch.trim().length > 0,
  };
}

/** Animated Standard | Fan out tabs in the create dialog's heading. */
export function FanoutModeSwitch({
  mode,
  onSwitch,
}: {
  mode: "single" | "fanout";
  onSwitch: (next: "single" | "fanout") => void;
}) {
  return (
    <Tabs
      value={mode}
      onValueChange={(next) => {
        if (next === "single" || next === "fanout") onSwitch(next);
      }}
    >
      <TabsList aria-label="Worktree type" className="h-7 text-xs">
        <TabsTrigger className="px-2 text-xs" value="single" onClick={() => onSwitch("single")}>
          Standard
        </TabsTrigger>
        <TabsTrigger className="px-2 text-xs" value="fanout" onClick={() => onSwitch("fanout")}>
          Fan out
        </TabsTrigger>
      </TabsList>
    </Tabs>
  );
}

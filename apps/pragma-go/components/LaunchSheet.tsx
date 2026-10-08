import { PragmaGatewayError } from "@pragma-sh/sdk";
import { router } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { View } from "react-native";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentModelSelector } from "@/components/AgentModelSelector";
import { FanoutAttemptRows } from "@/components/FanoutAttemptRows";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { useConnection } from "@/lib/connection-context";
import { catalogToSelectorAgents } from "@/lib/catalog";
import { defaultAgentSelection, type AgentModelSelection } from "@/lib/data/agents";
import {
  buildFanoutRequest,
  fanoutFailureMessage,
  initialAttempts,
  type FanoutAttempt,
} from "@/lib/fanout-form";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import {
  buildLaunchPayload,
  newBranchFields,
  runInFor,
  runtimeAgentId,
  targetForRunIn,
  type LaunchTarget,
  type RunIn,
} from "@/lib/launch-form";
import { useCatalog } from "@/lib/use-catalog";

interface LaunchSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  worktreeId: string;
}

/**
 * Bottom sheet to launch a new agent session from the phone. The agent picker
 * is fed by the host catalog (icons fetched through the authed AssetsClient);
 * the session runs in the current worktree or a fresh branch. On success it
 * navigates to the chat screen, which attaches and streams from session start.
 *
 * **Fan out** sends the same prompt to several agents at once, each in its own
 * attempt worktree off a fresh coordination branch, and opens the fanout's
 * compare view instead of a chat.
 */
export function LaunchSheet({ open, onOpenChange, projectId, worktreeId }: LaunchSheetProps) {
  const { client } = useConnection();
  const catalog = useCatalog();
  const agents = useMemo(() => catalogToSelectorAgents(catalog?.agents ?? []), [catalog]);

  const [selection, setSelection] = useState<AgentModelSelection | null>(null);
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<LaunchTarget>({ kind: "existing" });
  // Non-null exactly while the sheet is in fanout mode.
  const [attempts, setAttempts] = useState<FanoutAttempt[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default the selection once the catalog resolves.
  const effectiveSelection = selection ?? defaultAgentSelection(agents);
  const selectedCatalogAgent = catalog?.agents.find((a) => a.id === effectiveSelection?.agentId);

  function reset(): void {
    setPrompt("");
    setTarget({ kind: "existing" });
    setAttempts(null);
    setError(null);
  }

  async function launch(): Promise<void> {
    if (!client) return;
    const shared = {
      client,
      onOpenChange,
      projectId,
      prompt,
      reset,
      setBusy,
      setError,
      target,
      worktreeId,
    };
    const route = attempts
      ? await launchFanout({ ...shared, attempts })
      : await launchAgent({ ...shared, effectiveSelection });
    if (route) router.push(route);
  }

  return (
    <BottomSheet
      footer={
        <LaunchSheetActions
          busy={busy}
          fanout={attempts !== null}
          onCancel={() => onOpenChange(false)}
          onLaunch={launch}
        />
      }
      onOpenChange={onOpenChange}
      open={open}
    >
      <LaunchSheetHeader />
      <LaunchForm
        agents={agents}
        attempts={attempts}
        catalog={catalog}
        error={error}
        onAttemptsChange={setAttempts}
        onPromptChange={setPrompt}
        onSelectionChange={setSelection}
        onTargetChange={setTarget}
        prompt={prompt}
        selectedCatalogAgent={selectedCatalogAgent}
        selection={effectiveSelection}
        target={target}
      />
    </BottomSheet>
  );
}

interface LaunchAgentArgs {
  client: NonNullable<ReturnType<typeof useConnection>["client"]>;
  effectiveSelection: AgentModelSelection | null;
  onOpenChange: (open: boolean) => void;
  projectId: string;
  prompt: string;
  reset: () => void;
  setBusy: (busy: boolean) => void;
  setError: (error: string | null) => void;
  target: LaunchTarget;
  worktreeId: string;
}

async function launchAgent({
  client,
  effectiveSelection,
  onOpenChange,
  projectId,
  prompt,
  reset,
  setBusy,
  setError,
  target,
  worktreeId,
}: LaunchAgentArgs) {
  const payload = validateLaunch({
    effectiveSelection,
    projectId,
    prompt,
    setError,
    target,
    worktreeId,
  });
  if (!payload) return null;
  setBusy(true);
  setError(null);
  try {
    const result = await client.agents.launch(payload);
    hapticSuccess();
    onOpenChange(false);
    reset();
    return {
      pathname: "/chat/[tabId]",
      params: {
        tabId: result.tabId,
        agent: runtimeAgentId(payload.agentId),
        initialMessage: payload.prompt,
        initialMessageTs: String(Date.now()),
        title: "Agent Session",
        worktreeId: result.worktreeId,
      },
    } as const;
  } catch (caught) {
    setError(launchErrorMessage(caught));
    hapticWarning();
    return null;
  } finally {
    setBusy(false);
  }
}

function validateLaunch({
  effectiveSelection,
  projectId,
  prompt,
  setError,
  target,
  worktreeId,
}: {
  effectiveSelection: AgentModelSelection | null;
  projectId: string;
  prompt: string;
  setError: (error: string | null) => void;
  target: LaunchTarget;
  worktreeId: string;
}) {
  const built = buildLaunchPayload(
    { selection: effectiveSelection, prompt, target },
    { projectId, worktreeId },
  );
  if (built.ok) return built.payload;
  setError(built.reason);
  hapticWarning();
  return null;
}

interface LaunchFanoutArgs extends Omit<LaunchAgentArgs, "effectiveSelection"> {
  attempts: FanoutAttempt[];
}

/**
 * Creates the fanout and returns the compare route. A partly-provisioned fanout
 * resolves rather than throwing — the healthy attempts are real and running —
 * so it still opens; the compare view shows which attempts failed and offers
 * a retry for each.
 */
async function launchFanout({
  attempts,
  client,
  onOpenChange,
  projectId,
  prompt,
  reset,
  setBusy,
  setError,
  target,
  worktreeId,
}: LaunchFanoutArgs) {
  const built = buildFanoutRequest(
    { prompt, ...newBranchFields(target), attempts },
    { projectId, worktreeId },
  );
  if (!built.ok) {
    setError(built.reason);
    hapticWarning();
    return null;
  }
  setBusy(true);
  setError(null);
  try {
    const result = await client.fanouts.create(built.request);
    hapticSuccess();
    onOpenChange(false);
    reset();
    return { pathname: "/fanout/[fanoutId]", params: { fanoutId: result.fanout.id } } as const;
  } catch (caught) {
    setError(fanoutFailureMessage(caught, "Couldn't start the fanout. Try again."));
    hapticWarning();
    return null;
  } finally {
    setBusy(false);
  }
}

function launchErrorMessage(caught: unknown): string {
  if (caught instanceof PragmaGatewayError && caught.httpStatus === 409) {
    return "Open Pragma on your computer to launch sessions.";
  }
  return "Couldn't launch the session. Try again.";
}

function LaunchSheetHeader() {
  return (
    <View className="gap-1">
      <Text className="text-lg font-semibold">Launch agent</Text>
      <Text className="text-sm text-muted-foreground">
        Start a new agent session in this worktree or a fresh branch, or fan one prompt out to
        several agents.
      </Text>
    </View>
  );
}

// The thick props preamble below is the form's surface, spelled one prop per
// line by the formatter; the neighbouring components' preambles look alike but
// hold no extractable logic.
function LaunchForm({
  // fallow-ignore-next-line code-duplication -- formatter-produced props preamble.
  agents,
  attempts,
  catalog,
  error,
  onAttemptsChange,
  onPromptChange,
  onSelectionChange,
  onTargetChange,
  prompt,
  selectedCatalogAgent,
  selection,
  target,
}: {
  agents: ReturnType<typeof catalogToSelectorAgents>;
  attempts: FanoutAttempt[] | null;
  catalog: ReturnType<typeof useCatalog>;
  error: string | null;
  onAttemptsChange: (attempts: FanoutAttempt[] | null) => void;
  onPromptChange: (text: string) => void;
  onSelectionChange: (selection: AgentModelSelection) => void;
  onTargetChange: (target: LaunchTarget) => void;
  prompt: string;
  selectedCatalogAgent: NonNullable<ReturnType<typeof useCatalog>>["agents"][number] | undefined;
  selection: AgentModelSelection | null;
  target: LaunchTarget;
}) {
  return (
    <View className="mt-5 gap-4">
      <AttemptsOrAgentField
        agents={agents}
        attempts={attempts}
        catalog={catalog}
        onAttemptsChange={onAttemptsChange}
        onSelectionChange={onSelectionChange}
        selectedCatalogAgent={selectedCatalogAgent}
        selection={selection}
      />
      <RunInRow
        attempts={attempts}
        onAttemptsChange={onAttemptsChange}
        onTargetChange={onTargetChange}
        selection={selection}
        target={target}
      />
      {target.kind === "new" ? (
        <BranchField fanout={attempts !== null} onTargetChange={onTargetChange} target={target} />
      ) : null}
      <PromptField fanout={attempts !== null} onPromptChange={onPromptChange} prompt={prompt} />
      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}

/**
 * The agent half of the form: one picker in a normal launch, one removable
 * picker per attempt when fanning out. Both are the same decision, so both
 * use the same selector.
 */
function AttemptsOrAgentField({
  agents,
  attempts,
  catalog,
  onAttemptsChange,
  onSelectionChange,
  selectedCatalogAgent,
  selection,
}: {
  agents: ReturnType<typeof catalogToSelectorAgents>;
  attempts: FanoutAttempt[] | null;
  catalog: ReturnType<typeof useCatalog>;
  onAttemptsChange: (attempts: FanoutAttempt[] | null) => void;
  onSelectionChange: (selection: AgentModelSelection) => void;
  selectedCatalogAgent: NonNullable<ReturnType<typeof useCatalog>>["agents"][number] | undefined;
  selection: AgentModelSelection | null;
}) {
  if (attempts) {
    return (
      <Field label="Attempts">
        <FanoutAttemptRows
          agents={agents}
          attempts={attempts}
          catalog={catalog}
          onChange={onAttemptsChange}
        />
      </Field>
    );
  }
  return (
    <AgentField
      agents={agents}
      icon={selectedCatalogAgent?.icon}
      onSelectionChange={onSelectionChange}
      selection={selection}
    />
  );
}

/**
 * The "Run in" tabs plus what switching them means: leaving "Fan out" drops
 * the attempt rows, and joining it seeds them from the single selection.
 */
function RunInRow({
  attempts,
  onAttemptsChange,
  onTargetChange,
  selection,
  target,
}: {
  attempts: FanoutAttempt[] | null;
  onAttemptsChange: (attempts: FanoutAttempt[] | null) => void;
  onTargetChange: (target: LaunchTarget) => void;
  selection: AgentModelSelection | null;
  target: LaunchTarget;
}) {
  const handleChange = (next: string): void => {
    onTargetChange(targetForRunIn(next, target));
    onAttemptsChange(next === "fanout" ? (attempts ?? initialAttempts(selection)) : null);
  };
  return <RunInField onValueChange={handleChange} value={runInFor(target, attempts !== null)} />;
}

function AgentField({
  agents,
  icon,
  onSelectionChange,
  selection,
}: {
  agents: ReturnType<typeof catalogToSelectorAgents>;
  icon: NonNullable<ReturnType<typeof useCatalog>>["agents"][number]["icon"] | undefined;
  onSelectionChange: (selection: AgentModelSelection) => void;
  selection: AgentModelSelection | null;
}) {
  return (
    <Field label="Agent">
      <View className="flex-row items-center gap-2">
        <AgentIcon fallback="◆" icon={icon} size={22} />
        <View className="flex-1">
          <AgentModelSelector agents={agents} onChange={onSelectionChange} value={selection} />
        </View>
      </View>
    </Field>
  );
}

function RunInField({
  onValueChange,
  value,
}: {
  onValueChange: (next: string) => void;
  value: RunIn;
}) {
  return (
    <Field label="Run in">
      <Tabs value={value} onValueChange={onValueChange}>
        <TabsList className="w-full">
          <TabsTrigger value="existing">
            <Text>This worktree</Text>
          </TabsTrigger>
          <TabsTrigger value="new">
            <Text>New branch</Text>
          </TabsTrigger>
          <TabsTrigger value="fanout">
            <Text>Fan out</Text>
          </TabsTrigger>
        </TabsList>
      </Tabs>
    </Field>
  );
}

/**
 * The new branch's name — for a fanout, its coordination branch.
 *
 * A plain View on purpose: a Reanimated entering animation inside the bottom
 * sheet's modal never runs to completion on iOS, which left this field laid out
 * but fully transparent.
 */
function BranchField({
  fanout,
  onTargetChange,
  target,
}: {
  fanout: boolean;
  onTargetChange: (target: LaunchTarget) => void;
  target: Extract<LaunchTarget, { kind: "new" }>;
}) {
  return (
    <View>
      <Field label={fanout ? "Fanout branch" : "Branch name"}>
        <Input
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={(text) =>
            onTargetChange({ kind: "new", branch: text.replace(/\s+/g, "-"), title: target.title })
          }
          placeholder="feature-branch"
          value={target.branch}
        />
      </Field>
    </View>
  );
}

function PromptField({
  fanout,
  onPromptChange,
  prompt,
}: {
  fanout: boolean;
  onPromptChange: (text: string) => void;
  prompt: string;
}) {
  return (
    <Field label="Prompt">
      <Input
        className="h-28 py-2"
        multiline
        onChangeText={onPromptChange}
        placeholder={
          fanout
            ? "Describe what every attempt should do…"
            : "Describe what you want the agent to do…"
        }
        style={{ textAlignVertical: "top" }}
        value={prompt}
      />
    </Field>
  );
}

function LaunchSheetActions({
  busy,
  fanout,
  onCancel,
  onLaunch,
}: {
  busy: boolean;
  fanout: boolean;
  onCancel: () => void;
  onLaunch: () => void;
}) {
  return (
    <View className="mt-6 flex-row justify-end gap-3">
      <Button onPress={onCancel} variant="ghost">
        <Text>Cancel</Text>
      </Button>
      <Button
        className={busy ? "opacity-50" : undefined}
        disabled={busy}
        onPress={() => void onLaunch()}
      >
        <Text>{launchLabel(busy, fanout)}</Text>
      </Button>
    </View>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text className="text-sm font-medium text-foreground">{label}</Text>
      {children}
    </View>
  );
}

function launchLabel(busy: boolean, fanout: boolean): string {
  if (fanout) return busy ? "Fanning out…" : "Fan out";
  return busy ? "Launching…" : "Launch";
}

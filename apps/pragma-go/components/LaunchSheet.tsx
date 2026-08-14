import { PragmaGatewayError } from "@pragma/sdk";
import { router } from "expo-router";
import { type ReactNode, useMemo, useState } from "react";
import { View } from "react-native";
import Animated, { FadeInDown } from "react-native-reanimated";

import { AgentIcon } from "@/components/AgentIcon";
import { AgentModelSelector } from "@/components/AgentModelSelector";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { useConnection } from "@/lib/connection-context";
import { catalogToSelectorAgents } from "@/lib/catalog";
import { defaultAgentSelection, type AgentModelSelection } from "@/lib/data/agents";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";
import { buildLaunchPayload, runtimeAgentId, type LaunchTarget } from "@/lib/launch-form";
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
 */
export function LaunchSheet({ open, onOpenChange, projectId, worktreeId }: LaunchSheetProps) {
  const { client } = useConnection();
  const catalog = useCatalog();
  const agents = useMemo(() => catalogToSelectorAgents(catalog?.agents ?? []), [catalog]);

  const [selection, setSelection] = useState<AgentModelSelection | null>(null);
  const [prompt, setPrompt] = useState("");
  const [target, setTarget] = useState<LaunchTarget>({ kind: "existing" });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Default the selection once the catalog resolves.
  const effectiveSelection = selection ?? defaultAgentSelection(agents);
  const selectedCatalogAgent = catalog?.agents.find((a) => a.id === effectiveSelection?.agentId);

  function reset(): void {
    setPrompt("");
    setTarget({ kind: "existing" });
    setError(null);
  }

  async function launch(): Promise<void> {
    if (!client) return;
    const result = await launchAgent({
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
    });
    if (result) router.push(result);
  }

  return (
    <BottomSheet onOpenChange={onOpenChange} open={open}>
      <LaunchSheetHeader />
      <LaunchForm
        agents={agents}
        error={error}
        onPromptChange={setPrompt}
        onSelectionChange={setSelection}
        onTargetChange={setTarget}
        prompt={prompt}
        selectedCatalogAgent={selectedCatalogAgent}
        selection={effectiveSelection}
        target={target}
      />
      <LaunchSheetActions busy={busy} onCancel={() => onOpenChange(false)} onLaunch={launch} />
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
        Start a new agent session in this worktree or a fresh branch.
      </Text>
    </View>
  );
}

function LaunchForm({
  agents,
  error,
  onPromptChange,
  onSelectionChange,
  onTargetChange,
  prompt,
  selectedCatalogAgent,
  selection,
  target,
}: {
  agents: ReturnType<typeof catalogToSelectorAgents>;
  error: string | null;
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
      <Field label="Agent">
        <View className="flex-row items-center gap-2">
          <AgentIcon fallback="◆" icon={selectedCatalogAgent?.icon} size={22} />
          <View className="flex-1">
            <AgentModelSelector agents={agents} onChange={onSelectionChange} value={selection} />
          </View>
        </View>
      </Field>

      <Field label="Run in">
        <Tabs
          value={target.kind}
          onValueChange={(next) =>
            onTargetChange(
              next === "existing" ? { kind: "existing" } : { kind: "new", branch: "", title: "" },
            )
          }
        >
          <TabsList className="w-full">
            <TabsTrigger value="existing">
              <Text>This worktree</Text>
            </TabsTrigger>
            <TabsTrigger value="new">
              <Text>New branch</Text>
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </Field>

      {target.kind === "new" ? (
        <Animated.View entering={FadeInDown.duration(200)}>
          <Field label="Branch name">
            <Input
              autoCapitalize="none"
              autoCorrect={false}
              onChangeText={(text) =>
                onTargetChange({
                  kind: "new",
                  branch: text.replace(/\s+/g, "-"),
                  title: target.title,
                })
              }
              placeholder="feature-branch"
              value={target.branch}
            />
          </Field>
        </Animated.View>
      ) : null}

      <Field label="Prompt">
        <Input
          className="h-28 py-2"
          multiline
          onChangeText={onPromptChange}
          placeholder="Describe what you want the agent to do…"
          style={{ textAlignVertical: "top" }}
          value={prompt}
        />
      </Field>

      {error ? <Text className="text-sm text-destructive">{error}</Text> : null}
    </View>
  );
}

function LaunchSheetActions({
  busy,
  onCancel,
  onLaunch,
}: {
  busy: boolean;
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
        <Text>{busy ? "Launching…" : "Launch"}</Text>
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

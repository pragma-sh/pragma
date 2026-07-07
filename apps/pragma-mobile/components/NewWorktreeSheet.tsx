import { type ReactNode, useState } from "react";
import { View } from "react-native";

import { AgentModelSelector } from "@/components/AgentModelSelector";
import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { defaultAgentSelection, type AgentModelSelection } from "@/lib/data/agents";
import { hapticSuccess } from "@/lib/haptics";

interface NewWorktreeSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Bottom sheet adapting the desktop "New worktree" dialog for mobile: the user
 * names a branch, optionally a display title, and can seed an agent prompt.
 * Front-end only for now — submitting just closes the sheet (no server wiring).
 */
export function NewWorktreeSheet({ open, onOpenChange }: NewWorktreeSheetProps) {
  const [branch, setBranch] = useState("");
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [agent, setAgent] = useState<AgentModelSelection | null>(defaultAgentSelection());

  const canSubmit = branch.trim().length > 0;

  function close() {
    onOpenChange(false);
    setBranch("");
    setTitle("");
    setPrompt("");
  }

  function submit() {
    if (!canSubmit) return;
    // Front-end only: no server wiring yet — creating just dismisses the sheet.
    hapticSuccess();
    close();
  }

  return (
    <BottomSheet onOpenChange={onOpenChange} open={open}>
      <View className="gap-1">
        <Text className="text-lg font-semibold">New worktree</Text>
        <Text className="text-sm text-muted-foreground">
          Branches from the selected parent worktree HEAD. Add a prompt to launch an agent session
          in it.
        </Text>
      </View>

      <View className="mt-5 gap-4">
        <Field label="Branch name">
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(text) => setBranch(text.replace(/\s+/g, "-"))}
            placeholder="feature-branch"
            value={branch}
          />
        </Field>
        <Field label="Display title">
          <Input
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={setTitle}
            placeholder="Optional"
            value={title}
          />
        </Field>
        <Field label="Agent">
          <AgentModelSelector onChange={setAgent} value={agent} />
        </Field>
        <Field label="Prompt">
          <Input
            className="h-28 py-2"
            multiline
            onChangeText={setPrompt}
            placeholder="Describe what you want the agent to do… (leave empty to skip the session)"
            style={{ textAlignVertical: "top" }}
            value={prompt}
          />
        </Field>
      </View>

      <View className="mt-6 flex-row justify-end gap-3">
        <Button onPress={close} variant="ghost">
          <Text>Cancel</Text>
        </Button>
        <Button
          className={canSubmit ? undefined : "opacity-50"}
          disabled={!canSubmit}
          onPress={submit}
        >
          <Text>Create worktree</Text>
        </Button>
      </View>
    </BottomSheet>
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

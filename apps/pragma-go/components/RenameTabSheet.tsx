import { useEffect, useState } from "react";
import { Alert, View } from "react-native";

import { BottomSheet } from "@/components/ui/bottom-sheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { hapticSuccess, hapticWarning } from "@/lib/haptics";

/** The part of a tab this sheet needs: what to rename, and its current name. */
export interface RenameableTab {
  id: string;
  title: string;
}

/**
 * Renames one workspace tab.
 *
 * Shared by agent sessions and ordinary terminals: both are tabs the host owns,
 * both rename through the same `tabRename` control, and a phone should not grow
 * two different rename dialogs for the same operation.
 */
export function RenameTabSheet({
  description,
  errorTitle,
  heading,
  onDone,
  rename,
  tab,
}: {
  /** One line under the heading explaining what the title is for. */
  description: string;
  /** Alert title used when the host refuses the rename. */
  errorTitle: string;
  /** Sheet heading, e.g. "Rename terminal". */
  heading: string;
  /** Closes the sheet — on cancel, on dismissal, and after a rename lands. */
  onDone: () => void;
  rename: (tabId: string, title: string) => Promise<void>;
  /** The tab being renamed; `null` keeps the sheet closed. */
  tab: RenameableTab | null;
}) {
  const [title, setTitle] = useState("");
  const [renaming, setRenaming] = useState(false);

  // Seed the field from the tab each time one is opened, so the sheet never
  // shows the previous tab's name for a frame.
  useEffect(() => {
    if (tab) setTitle(tab.title);
  }, [tab]);

  const nextTitle = title.trim();
  const canRename = nextTitle.length > 0 && !renaming;

  async function submit(): Promise<void> {
    if (!tab || !canRename) return;
    setRenaming(true);
    try {
      await rename(tab.id, nextTitle);
      hapticSuccess();
      onDone();
    } catch {
      hapticWarning();
      Alert.alert(errorTitle, "The host could not rename this tab.");
    } finally {
      setRenaming(false);
    }
  }

  return (
    <BottomSheet
      footer={
        <View className="mt-3 flex-row justify-end gap-2">
          <Button onPress={onDone} size="sm" variant="outline">
            <Text>Cancel</Text>
          </Button>
          <Button disabled={!canRename} onPress={() => void submit()} size="sm">
            <Text>{renaming ? "Renaming..." : "Rename"}</Text>
          </Button>
        </View>
      }
      onOpenChange={(open) => !open && onDone()}
      open={!!tab}
    >
      <View className="gap-1">
        <Text className="text-lg font-semibold">{heading}</Text>
        <Text className="text-sm text-muted-foreground">{description}</Text>
      </View>
      <View className="mt-5 gap-3">
        <Input
          autoFocus
          onChangeText={setTitle}
          onSubmitEditing={() => void submit()}
          value={title}
        />
      </View>
    </BottomSheet>
  );
}

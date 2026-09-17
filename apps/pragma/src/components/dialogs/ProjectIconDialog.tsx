import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { errorMessage } from "@/lib/errors";
import { setProjectIcon } from "@/lib/tauri";
import { useWorkspace } from "@/state/workspace-context";

interface ProjectIconDialogProps {
  projectId: string;
  projectName: string;
  /** The project's current emoji override, or null when it has none. */
  iconEmoji: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Emoji picker for a project's switcher icon, opened from the project's context
 * menu. Picking a glyph saves and closes; the picker's reset button clears the
 * override so the switcher falls back to a favicon found in the checkout, then
 * to the project name's initial.
 */
export function ProjectIconDialog({
  projectId,
  projectName,
  iconEmoji,
  open,
  onOpenChange,
}: ProjectIconDialogProps) {
  const workspace = useWorkspace();

  async function save(emoji: string | null) {
    try {
      await setProjectIcon(projectId, emoji);
      await workspace.reload();
      onOpenChange(false);
    } catch (cause) {
      toast.error(`Failed to set project icon: ${errorMessage(cause)}`);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set icon</DialogTitle>
          <DialogDescription>
            Pick the emoji shown for {projectName} in the project switcher.
          </DialogDescription>
        </DialogHeader>
        <EmojiPicker
          onReset={() => void save(null)}
          onSelect={(emoji) => void save(emoji)}
          resetLabel="Reset to default icon"
          value={iconEmoji}
        />
      </DialogContent>
    </Dialog>
  );
}

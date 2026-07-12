import { constants, type EditorLauncher } from "@pragma/constants";

import { isMacPlatform } from "@/lib/platform";

const SYSTEM_LAUNCHER_ID = constants.editorLaunchers.defaultEditorId;

/**
 * The system file-explorer launcher, renamed/re-iconed to match the platform's
 * actual file manager. `@pragma/constants` only knows the generic "File
 * Explorer" label since it's shared cross-platform; the real app on macOS is
 * Finder.
 */
const MAC_SYSTEM_LAUNCHER_OVERRIDE: Partial<EditorLauncher> = {
  name: "Finder",
  brandIcon: "brand:finder",
  brandColor: "#1e73f2",
};

/**
 * `constants.editorLaunchers.options`, with the system file-explorer entry
 * relabeled to "Finder" on macOS. Use this instead of the raw constant
 * wherever editor launchers are rendered.
 */
export const editorLaunchers: EditorLauncher[] = isMacPlatform()
  ? constants.editorLaunchers.options.map((editor) =>
      editor.id === SYSTEM_LAUNCHER_ID ? { ...editor, ...MAC_SYSTEM_LAUNCHER_OVERRIDE } : editor,
    )
  : constants.editorLaunchers.options;

import type { KeybindingPlatform } from "@/lib/keybindings";

/**
 * Text-like `<input>` types where the OS's native text-editing shortcuts
 * (Cmd/Option+arrows, Cmd+Backspace, etc.) should apply instead of app
 * shortcuts like `deleteFile`.
 */
const TEXT_INPUT_TYPES = new Set(["text", "search", "url", "email", "password", "tel", "number"]);

/**
 * Returns true when `element` is a text-editing context — an `<input>` (text-like
 * type), `<textarea>`, `contenteditable` host, the xterm terminal, or a CodeMirror
 * editor.
 *
 * Used to decide whether OS-native text-editing shortcuts should take over from
 * app shortcuts. For example Cmd+Backspace deletes to the beginning of a line
 * here, instead of deleting a file selected in the file tree.
 */
export function isTextEditingContext(element: Element | null | undefined): boolean {
  if (!element) {
    return false;
  }
  const tag = element.tagName.toLowerCase();
  if (tag === "textarea") {
    return true;
  }
  if (tag === "input") {
    return TEXT_INPUT_TYPES.has((element as HTMLInputElement).type.toLowerCase());
  }
  if (element instanceof HTMLElement && element.isContentEditable) {
    return true;
  }
  // xterm.js focuses a hidden <textarea> inside `.xterm` (caught above), but the
  // active element can also be the terminal's canvas/container.
  if (element.closest(".xterm")) {
    return true;
  }
  // CodeMirror 6 mounts under `.cm-editor`.
  if (element.closest(".cm-editor")) {
    return true;
  }
  if (element.closest('[role="textbox"]')) {
    return true;
  }
  return false;
}

/**
 * Maps a native OS text-editing chord to the readline-compatible control
 * sequence a shell expects, or returns `null` if the event isn't a native
 * editing shortcut for the platform.
 *
 * These are OS conventions (macOS Option/Command arrows, Linux Ctrl+arrows),
 * not user-configurable app shortcuts — they're intentionally kept out of
 * `~/.pragma/keybindings.json`. In the terminal they translate to the same
 * control characters readline already binds: Ctrl+A/E for line start/end,
 * ESC+B/F for word motion, Ctrl+U to delete a line, Ctrl+W to delete a word.
 *
 * Shift-modified variants are left alone so xterm's own shift-selection keeps
 * working.
 *
 * On macOS:
 * - Cmd+Backspace → Ctrl+U (delete to beginning of line)
 * - Cmd+Left/Right → Ctrl+A/E (beginning/end of line)
 * - Option+Left/Right → ESC+B/F (back/forward word)
 * - Option+Backspace → Ctrl+W (delete word backward)
 *
 * On Linux:
 * - Ctrl+Backspace → Ctrl+W (delete word backward)
 * - Ctrl+Delete → ESC+D (delete word forward)
 * - Ctrl+Left/Right → ESC+B/F (back/forward word)
 */
export function nativeEditingSequence(
  event: KeyboardEvent,
  platform: KeybindingPlatform,
): string | null {
  if (event.type !== "keydown" || event.shiftKey) {
    return null;
  }
  const { key, altKey, ctrlKey, metaKey } = event;

  if (platform === "mac") {
    if (metaKey && !altKey && !ctrlKey) {
      switch (key) {
        case "Backspace":
          return "\x15"; // Ctrl+U — delete to beginning of line
        case "ArrowLeft":
          return "\x01"; // Ctrl+A — beginning of line
        case "ArrowRight":
          return "\x05"; // Ctrl+E — end of line
      }
    }
    if (altKey && !metaKey && !ctrlKey) {
      switch (key) {
        case "Backspace":
          return "\x17"; // Ctrl+W — delete word backward
        case "ArrowLeft":
          return "\x1bb"; // ESC+B — back word
        case "ArrowRight":
          return "\x1bf"; // ESC+F — forward word
      }
    }
    return null;
  }

  // Linux
  if (ctrlKey && !altKey && !metaKey) {
    switch (key) {
      case "Backspace":
        return "\x17"; // Ctrl+W — delete word backward
      case "Delete":
        return "\x1bd"; // ESC+D — delete word forward
      case "ArrowLeft":
        return "\x1bb"; // ESC+B — back word
      case "ArrowRight":
        return "\x1bf"; // ESC+F — forward word
    }
  }
  return null;
}

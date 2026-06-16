import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@iconify/react";

import { fileIconId, folderIconId } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

const INDENT_PX = 12;

/** Index of the last `.` in `name`, or `-1` if none. */
function extensionIndex(name: string): number {
  const slash = name.lastIndexOf("/");
  const dot = name.lastIndexOf(".");
  if (dot <= 0 || dot < slash) {
    return -1;
  }
  return dot;
}

/**
 * Inline rename row rendered in place of a file/folder label. Pre-fills the
 * current basename and selects the basename (leaving the extension unselected
 * for files) on focus. Enter commits a valid name; Escape (or blur) cancels.
 * The backend `rename_file` command is the real guard — this validation is a
 * convenience that mirrors {@link NewEntryInput}.
 *
 * The original name is excluded from the duplicate-name check so a same-name
 * rename (effectively a no-op) stays a valid commit.
 */
export function RenameEntryInput({
  initialName,
  kind,
  depth,
  siblings,
  onCommit,
  onCancel,
}: {
  initialName: string;
  kind: "file" | "folder";
  depth: number;
  siblings: string[];
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialName);
  const committedRef = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const siblingSet = useMemo(
    () =>
      new Set(siblings.filter((name) => name !== initialName).map((name) => name.toLowerCase())),
    [siblings, initialName],
  );

  useEffect(() => {
    const input = inputRef.current;
    if (!input) {
      return;
    }
    input.focus();
    if (kind === "file") {
      const dot = extensionIndex(initialName);
      input.setSelectionRange(0, dot > 0 ? dot : initialName.length);
    } else {
      input.select();
    }
  }, [initialName, kind]);

  const trimmed = value.trim();
  const invalid =
    trimmed === "" ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    siblingSet.has(trimmed.toLowerCase());

  const submit = () => {
    if (invalid || committedRef.current) {
      return;
    }
    committedRef.current = true;
    onCommit(trimmed);
  };

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-0.5"
      style={{ paddingLeft: depth * INDENT_PX + 8 }}
    >
      <Icon
        className="size-4 shrink-0"
        icon={kind === "folder" ? folderIconId(false) : fileIconId(value || initialName)}
      />
      <input
        ref={inputRef}
        aria-label={kind === "folder" ? "Rename folder" : "Rename file"}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        className={cn(
          "w-full min-w-0 max-w-[14rem] rounded border bg-black/40 px-1 text-xs text-slate-100 outline-none",
          value && invalid ? "border-red-400/70" : "border-cyan-400/50",
        )}
        spellCheck="false"
        style={{ textTransform: "none" }}
        onBlur={() => {
          if (!committedRef.current) {
            onCancel();
          }
        }}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            submit();
          } else if (event.key === "Escape") {
            event.preventDefault();
            onCancel();
          }
        }}
        value={value}
      />
    </div>
  );
}

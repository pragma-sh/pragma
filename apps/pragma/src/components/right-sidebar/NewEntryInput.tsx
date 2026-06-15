import { useMemo, useRef, useState } from "react";

import { Icon } from "@iconify/react";

import { fileIconId, folderIconId } from "@/lib/file-icons";
import { cn } from "@/lib/utils";

const INDENT_PX = 12;

/**
 * Inline create row rendered as the first child of a directory. Validates the
 * name against the directory's existing entries (case-insensitive) and rejects
 * empty names or path separators, showing a red border while invalid. Enter
 * commits a valid name; Escape (or blur) cancels. The backend `create_*`
 * commands are the real guard — this validation is a convenience.
 */
export function NewEntryInput({
  kind,
  depth,
  siblings,
  onCommit,
  onCancel,
}: {
  kind: "file" | "folder";
  depth: number;
  siblings: string[];
  onCommit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const committedRef = useRef(false);
  const siblingSet = useMemo(() => new Set(siblings.map((name) => name.toLowerCase())), [siblings]);

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
        icon={kind === "folder" ? folderIconId(false) : fileIconId(value || "file")}
      />
      <input
        aria-label={kind === "folder" ? "New folder name" : "New file name"}
        autoCapitalize="off"
        autoComplete="off"
        autoCorrect="off"
        // oxlint-disable-next-line jsx-a11y/no-autofocus -- the create row is opened on demand and must take focus
        autoFocus
        className={cn(
          "w-full min-w-0 rounded border bg-black/40 px-1 text-xs text-slate-100 outline-none",
          value && invalid ? "border-red-400/70" : "border-cyan-400/50",
        )}
        spellCheck="false"
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
        placeholder={kind === "folder" ? "new-folder" : "new-file.ts"}
        value={value}
      />
    </div>
  );
}

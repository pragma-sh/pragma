import { useRef, useState, type RefObject } from "react";

import type { Tab } from "@pragma/constants";

import {
  useEditorFileLoader,
  useEditorOnChange,
  useEditorSave,
  useSaveShortcut,
} from "@/components/editor/use-editor-file";
import {
  parseScratchpadDocument,
  replaceScratchpadBody,
  type ScratchpadDocument,
} from "@/components/scratchpad/scratchpad-document";
import { errorMessage } from "@/lib/errors";

export interface ScratchpadFile {
  state: ReturnType<typeof useEditorFileLoader>["state"];
  load: ReturnType<typeof useEditorFileLoader>["load"];
  /** True when the file changed on disk under an unsaved buffer. */
  externalChange: boolean;
  reloadFromDisk: () => void;
  /** The tab's unsaved text, which is the whole MDX file including frontmatter. */
  currentDocRef: RefObject<string>;
  save: (next: string) => Promise<void>;
  onChange: (next: string) => void;
  handleSaveShortcut: ReturnType<typeof useSaveShortcut>;
  /** The parsed document, or null while loading or when it is malformed. */
  document: ScratchpadDocument | null;
  documentError: string | null;
  /** Rewrites just the body, preserving the document's managed frontmatter. */
  updateBody: (body: string) => void;
  saveBody: (body: string) => Promise<void>;
  /** Re-parses after something outside this hook rewrote the document text. */
  refreshDocument: (next: string) => void;
}

/**
 * Owns a scratchpad's file lifecycle: load, parse, dirty-tracking, and save,
 * exposing body-level edits that keep the managed frontmatter intact.
 */
export function useScratchpadFile(tab: Tab): ScratchpadFile {
  const { id: tabId, worktreeId, filePath } = tab;
  const savedDocRef = useRef("");
  const currentDocRef = useRef("");
  const documentRef = useRef<ScratchpadDocument | null>(null);
  const [, setRevision] = useState(0);

  const { state, load, externalChange, reloadFromDisk } = useEditorFileLoader(
    tab,
    savedDocRef,
    currentDocRef,
  );
  const save = useEditorSave(tabId, worktreeId, filePath, savedDocRef);
  const onChange = useEditorOnChange(tabId, savedDocRef, currentDocRef);
  const handleSaveShortcut = useSaveShortcut(save, currentDocRef);

  const { document, documentError } = readDocument(state.kind === "ready", currentDocRef.current);
  if (document) documentRef.current = document;

  const updateBody = (body: string): void => {
    const current = documentRef.current;
    if (current) onChange(replaceScratchpadBody(current, body));
  };

  const saveBody = (body: string): Promise<void> => {
    const current = documentRef.current;
    return save(current ? replaceScratchpadBody(current, body) : currentDocRef.current);
  };

  const refreshDocument = (next: string): void => {
    documentRef.current = parseScratchpadDocument(next);
    setRevision((value) => value + 1);
  };

  return {
    state,
    load,
    externalChange,
    reloadFromDisk,
    currentDocRef,
    save,
    onChange,
    handleSaveShortcut,
    document,
    documentError,
    updateBody,
    saveBody,
    refreshDocument,
  };
}

/** Parses the loaded scratchpad, reporting a malformed document instead of throwing. */
function readDocument(
  ready: boolean,
  text: string,
): { document: ScratchpadDocument | null; documentError: string | null } {
  if (!ready) return { document: null, documentError: null };
  try {
    return { document: parseScratchpadDocument(text), documentError: null };
  } catch (cause) {
    return { document: null, documentError: errorMessage(cause) };
  }
}

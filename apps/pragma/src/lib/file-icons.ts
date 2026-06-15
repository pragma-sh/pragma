import { addCollection } from "@iconify/react";
import { icons as vscodeIcons } from "@iconify-json/vscode-icons";

import { basename } from "@/lib/path";

/**
 * VS Code file icons, resolved entirely offline.
 *
 * `@iconify/react`'s `<Icon>` otherwise fetches unknown icons from the Iconify
 * API over the network — unacceptable in a desktop app and flaky in tests.
 * Registering the bundled collection once makes `<Icon icon="vscode-icons:…" />`
 * resolve synchronously from local data.
 */
addCollection(vscodeIcons);

/** Exact-filename overrides (checked before the extension map). */
const FULL_NAME_ICONS: Record<string, string> = {
  "package.json": "vscode-icons:file-type-node",
  "package-lock.json": "vscode-icons:file-type-node",
  "bun.lock": "vscode-icons:file-type-bun",
  "bun.lockb": "vscode-icons:file-type-bun",
  "tsconfig.json": "vscode-icons:file-type-tsconfig",
  dockerfile: "vscode-icons:file-type-docker2",
  ".gitignore": "vscode-icons:file-type-git",
  ".gitattributes": "vscode-icons:file-type-git",
  "cargo.toml": "vscode-icons:file-type-cargo",
  "cargo.lock": "vscode-icons:file-type-cargo",
  "readme.md": "vscode-icons:file-type-markdown",
  license: "vscode-icons:file-type-license",
};

/** Extension → icon map, keyed by lowercased extension (no leading dot). */
const EXT_ICONS: Record<string, string> = {
  ts: "vscode-icons:file-type-typescript",
  tsx: "vscode-icons:file-type-reactts",
  js: "vscode-icons:file-type-js",
  jsx: "vscode-icons:file-type-reactjs",
  mjs: "vscode-icons:file-type-js",
  cjs: "vscode-icons:file-type-js",
  json: "vscode-icons:file-type-json",
  rs: "vscode-icons:file-type-rust",
  toml: "vscode-icons:file-type-toml",
  md: "vscode-icons:file-type-markdown",
  mdx: "vscode-icons:file-type-mdx",
  css: "vscode-icons:file-type-css",
  scss: "vscode-icons:file-type-scss",
  html: "vscode-icons:file-type-html",
  svg: "vscode-icons:file-type-svg",
  png: "vscode-icons:file-type-image",
  jpg: "vscode-icons:file-type-image",
  jpeg: "vscode-icons:file-type-image",
  gif: "vscode-icons:file-type-image",
  yml: "vscode-icons:file-type-yaml",
  yaml: "vscode-icons:file-type-yaml",
  sh: "vscode-icons:file-type-shell",
  lock: "vscode-icons:file-type-lock",
  txt: "vscode-icons:file-type-text",
};

const DEFAULT_FILE_ICON = "vscode-icons:default-file";

/** Resolves a file name to a bundled `vscode-icons:*` icon id. */
export function fileIconId(name: string): string {
  const lower = basename(name).toLowerCase();
  const exact = FULL_NAME_ICONS[lower];
  if (exact) {
    return exact;
  }
  const dot = lower.lastIndexOf(".");
  const ext = dot === -1 ? "" : lower.slice(dot + 1);
  return EXT_ICONS[ext] ?? DEFAULT_FILE_ICON;
}

/** Resolves a directory to its open/closed bundled folder icon id. */
export function folderIconId(open: boolean): string {
  return open ? "vscode-icons:default-folder-opened" : "vscode-icons:default-folder";
}

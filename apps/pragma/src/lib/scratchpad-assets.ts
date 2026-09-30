import { mediaMimeType } from "@/components/media/media-path";
import { readBinaryFile } from "@/lib/binary-file";
import { dirname, extname, joinPath, normalizeWorktreePath } from "@/lib/path";
import { getWhiteboard, viewWhiteboard } from "@/lib/tauri";

/** Converts document-relative resources to data URLs for offline HTML exports. */
export function scratchpadAssetReader(
  worktreeId: string,
  filePath: string,
): (url: string) => Promise<string> {
  const cache = new Map<string, Promise<string>>();
  return (url) => {
    if (url.startsWith("data:") || url.startsWith("#")) return Promise.resolve(url);
    let pending = cache.get(url);
    if (!pending) {
      pending = readAsset(url, worktreeId, filePath);
      cache.set(url, pending);
    }
    return pending;
  };
}

async function readAsset(url: string, worktreeId: string, filePath: string): Promise<string> {
  let blob: Blob;
  if (/^https?:/.test(url)) {
    const response = await fetch(url, { referrerPolicy: "no-referrer" });
    if (!response.ok) throw new Error(`Could not export asset ${url}: ${response.status}`);
    blob = await response.blob();
  } else {
    const path = decodeURIComponent(url.split(/[?#]/)[0] ?? "");
    const relative = normalizeWorktreePath(
      path.startsWith("/") ? path.slice(1) : joinPath(dirname(filePath), path),
    );
    const bytes = await readBinaryFile(worktreeId, relative, "export asset");
    const type = extname(path) === "svg" ? "image/svg+xml" : mediaMimeType(path);
    blob = new Blob([bytes], { type });
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "error",
      () => reject(reader.error ?? new Error(`Could not export asset ${url}`)),
      { once: true },
    );
    reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
    reader.readAsDataURL(blob);
  });
}

interface AssetNode {
  type?: string;
  name?: string;
  url?: string;
  identifier?: string;
  attributes?: { type: string; name?: string; value?: unknown }[];
  children?: AssetNode[];
}

/** Embeds Markdown images and literal media/iframe JSX attributes before MDX compilation. */
export async function inlineScratchpadAssets(
  tree: unknown,
  read: (url: string) => Promise<string>,
  worktreeId: string,
): Promise<void> {
  const root = tree as AssetNode;
  const imageReferences = new Set<string>();
  const jobs: Promise<void>[] = [];
  const nodes: AssetNode[] = [];
  const visit = (node: AssetNode): void => {
    nodes.push(node);
    if (node.type === "imageReference" && node.identifier) imageReferences.add(node.identifier);
    node.children?.forEach(visit);
  };
  visit(root);
  for (const node of nodes) {
    if (node.name === "Whiteboard") {
      const id = node.attributes?.find((attribute) => attribute.name === "id")?.value;
      if (typeof id === "string") jobs.push(inlineWhiteboard(node, worktreeId, id));
    }
    if (
      node.url &&
      (node.type === "image" ||
        (node.type === "definition" && imageReferences.has(node.identifier ?? "")))
    ) {
      jobs.push(
        read(node.url).then((url) => {
          node.url = url;
          return undefined;
        }),
      );
    }
    if (!["img", "video", "audio", "source", "iframe"].includes(node.name ?? "")) continue;
    for (const attribute of node.attributes ?? []) {
      if (["src", "poster"].includes(attribute.name ?? "") && typeof attribute.value === "string") {
        jobs.push(
          read(attribute.value).then((url) => {
            attribute.value = url;
            return undefined;
          }),
        );
      }
    }
  }
  await Promise.all(jobs);
}

async function inlineWhiteboard(node: AssetNode, worktreeId: string, id: string): Promise<void> {
  const board = await getWhiteboard(worktreeId, id);
  if (board.worktreeId !== worktreeId) throw new Error("Whiteboard belongs to another worktree");
  const rendered = await viewWhiteboard(
    worktreeId,
    id,
    document.documentElement.classList.contains("dark"),
  );
  node.name = "img";
  node.attributes = [
    { type: "mdxJsxAttribute", name: "src", value: `data:image/png;base64,${rendered.data}` },
    { type: "mdxJsxAttribute", name: "alt", value: board.title },
  ];
  node.children = [];
}

import * as React from "react";
import * as ReactDomClient from "react-dom/client";
import * as ReactJsxRuntime from "react/jsx-runtime";

import { compile } from "@mdx-js/mdx";
import * as Scratchpad from "@pragma/scratchpad";
import * as ScratchpadPrimitives from "@pragma/scratchpad/ui/primitives";
import * as ScratchpadUi from "@pragma/scratchpad/ui";
import { build, initialize, type Loader, type Plugin } from "esbuild-wasm";
import wasmUrl from "esbuild-wasm/esbuild.wasm?url";
import { legacy, resolve, type Package } from "resolve.exports";
import remarkGfm from "remark-gfm";

import { dirname, extname, joinPath } from "@/lib/path";
import { pathExists, readFile } from "@/lib/tauri";

interface PreviewBuildOptions {
  source: string;
  filePath: string;
  worktreeId: string;
}

/** Browser bundle produced for one scratchpad preview. */
export interface ScratchpadPreviewBundle {
  code: string;
  css: string;
}

let initializePromise: Promise<void> | null = null;

/** Compiles and bundles full MDX source for execution inside isolated preview iframe. */
export async function buildScratchpadPreview(
  options: PreviewBuildOptions,
): Promise<ScratchpadPreviewBundle> {
  await initializeEsbuild();
  const compiled = String(
    await compile(options.source, {
      format: "mdx",
      outputFormat: "program",
      development: false,
      remarkPlugins: [remarkGfm],
    }),
  );
  const result = await build({
    entryPoints: ["pragma:entry"],
    bundle: true,
    format: "iife",
    outfile: "scratchpad.js",
    platform: "browser",
    target: "es2022",
    write: false,
    sourcemap: "inline",
    plugins: [scratchpadModules(options, wrapImportedComponents(compiled))],
  });
  const code = result.outputFiles.find((file) => file.path.endsWith(".js"))?.text;
  if (!code) throw new Error("Scratchpad compiler did not produce JavaScript.");
  return {
    code,
    css: result.outputFiles.find((file) => file.path.endsWith(".css"))?.text ?? "",
  };
}

function initializeEsbuild(): Promise<void> {
  initializePromise ??= Promise.resolve()
    .then(() =>
      initialize({
        wasmURL: new URL(wasmUrl, globalThis.location.href).href,
        worker: true,
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof Error && error.message === 'Cannot call "initialize" more than once') {
        return;
      }
      initializePromise = null;
      throw error;
    });
  return initializePromise;
}

function scratchpadModules(options: PreviewBuildOptions, documentSource: string): Plugin {
  const textCache = new Map<string, string>();
  const builtins = new Map<string, string>([
    ["react", globalModule("React", React)],
    ["react/jsx-runtime", globalModule("ReactJsxRuntime", ReactJsxRuntime)],
    ["react/jsx-dev-runtime", globalModule("ReactJsxRuntime", ReactJsxRuntime)],
    ["react-dom/client", globalModule("ReactDomClient", ReactDomClient)],
    ["@pragma/scratchpad", globalModule("Scratchpad", Scratchpad)],
    ["@pragma/scratchpad/ui", globalModule("ScratchpadUi", ScratchpadUi)],
    [
      "@pragma/scratchpad/ui/primitives",
      globalModule("ScratchpadPrimitives", ScratchpadPrimitives),
    ],
    [
      "pragma:scratchpad-host",
      "export const withScratchpadBoundary = globalThis.pragmaScratchpadFrame.withScratchpadBoundary;",
    ],
  ]);

  return {
    name: "pragma-scratchpad-modules",
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^pragma:entry$/ }, () => ({
        path: "pragma:entry",
        namespace: "pragma-entry",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "pragma-entry" }, () => ({
        loader: "js",
        contents: `
          import React from "react";
          import { createRoot } from "react-dom/client";
          import { withScratchpadBoundary } from "pragma:scratchpad-host";
          import Content from "pragma:document";
          const BoundedContent = withScratchpadBoundary(Content, "Scratchpad document");
          createRoot(document.getElementById("root")).render(React.createElement(BoundedContent));
        `,
      }));
      pluginBuild.onResolve({ filter: /^pragma:document$/ }, () => ({
        path: options.filePath,
        namespace: "pragma-document",
      }));
      pluginBuild.onLoad({ filter: /.*/, namespace: "pragma-document" }, () => ({
        contents: documentSource,
        loader: "js",
        resolveDir: dirname(options.filePath),
      }));
      pluginBuild.onResolve({ filter: /.*/ }, (args) => {
        if (!builtins.has(args.path)) return undefined;
        return { path: args.path, namespace: "pragma-builtin" };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "pragma-builtin" }, (args) => ({
        contents: builtins.get(args.path) ?? "",
        loader: "js",
      }));
      pluginBuild.onResolve({ filter: /^https:/ }, (args) => ({
        path: args.path,
        namespace: "pragma-https",
      }));
      pluginBuild.onResolve({ filter: /^http:/ }, () => ({
        errors: [{ text: "Insecure HTTP imports are not supported; use HTTPS." }],
      }));
      pluginBuild.onResolve({ filter: /^\.?\.?\// }, async (args) => {
        if (args.namespace === "pragma-https") {
          return { path: new URL(args.path, args.importer).href, namespace: "pragma-https" };
        }
        const base = normalizePath(joinPath(args.resolveDir, args.path));
        const resolved = await resolveLocalFile(options.worktreeId, base);
        return resolved
          ? { path: resolved, namespace: "pragma-worktree" }
          : { errors: [{ text: `Could not resolve local import ${args.path}` }] };
      });
      pluginBuild.onResolve({ filter: /.*/ }, async (args) => {
        if (args.namespace === "pragma-https") {
          return {
            path: `https://esm.sh/${args.path}?bundle`,
            namespace: "pragma-https",
          };
        }
        if (
          args.path.startsWith("/") ||
          args.path.startsWith("file:") ||
          args.path.startsWith("node:")
        ) {
          return { errors: [{ text: `Unsupported import ${args.path}` }] };
        }
        const local = await resolveLocalPackage(options.worktreeId, args.path, args.resolveDir);
        if (local) return { path: local, namespace: "pragma-worktree" };
        return {
          path: `https://esm.sh/${args.path}?bundle`,
          namespace: "pragma-https",
        };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "pragma-worktree" }, async (args) => {
        const contents = await readText(options.worktreeId, args.path, textCache);
        return { contents, loader: loaderFor(args.path), resolveDir: dirname(args.path) };
      });
      pluginBuild.onLoad({ filter: /.*/, namespace: "pragma-https" }, async (args) => {
        const cached = textCache.get(args.path);
        if (cached !== undefined) return { contents: cached, loader: loaderFor(args.path) };
        const response = await fetch(args.path, { referrerPolicy: "no-referrer" });
        if (!response.ok) throw new Error(`Fetch ${args.path} failed: ${response.status}`);
        const contents = await response.text();
        textCache.set(args.path, contents);
        return { contents, loader: loaderFor(args.path) };
      });
    },
  };
}

function globalModule(name: string, values: object): string {
  const exports = Object.keys(values)
    .filter((key) => key !== "default" && /^[$A-Z_a-z][$\w]*$/.test(key))
    .map((key) => `export const ${key} = value[${JSON.stringify(key)}];`)
    .join("\n");
  return `const value = globalThis.pragmaScratchpadFrame.${name};\nexport default value.default ?? value;\n${exports}`;
}

function wrapImportedComponents(source: string): string {
  const wrappers: string[] = [];
  let index = 0;
  const defaultWrapped = source.replace(
    /^import\s+([A-Z][$\w]*)\s+from\s+(["'][^"']+["']);?$/gm,
    (_match, local: string, specifier: string) => {
      if (!rendersComponent(source, local)) return _match as string;
      const imported = `__PragmaImported${index++}`;
      wrappers.push(
        `const ${local} = withScratchpadBoundary(${imported}, ${JSON.stringify(local)});`,
      );
      return `import ${imported} from ${specifier};`;
    },
  );
  const namedWrapped = defaultWrapped.replace(
    /^import\s+\{([^}]+)\}\s+from\s+(["'][^"']+["']);?$/gm,
    (_match, bindings: string, specifier: string) => {
      const rewritten = bindings.split(",").map((binding) => {
        const [importedName, alias] = binding.trim().split(/\s+as\s+/);
        const local = alias ?? importedName;
        if (!importedName || !local || !rendersComponent(source, local)) return binding.trim();
        const temporary = `__PragmaImported${index++}`;
        wrappers.push(
          `const ${local} = withScratchpadBoundary(${temporary}, ${JSON.stringify(local)});`,
        );
        return `${importedName} as ${temporary}`;
      });
      return `import { ${rewritten.join(", ")} } from ${specifier};`;
    },
  );
  if (wrappers.length === 0) return namedWrapped;
  return `import { withScratchpadBoundary } from "pragma:scratchpad-host";\n${namedWrapped}\n${wrappers.join("\n")}`;
}

function rendersComponent(source: string, local: string): boolean {
  return new RegExp(`_jsx(?:s)?\\(\\s*${local}\\b`).test(source);
}

async function resolveLocalPackage(
  worktreeId: string,
  specifier: string,
  importerDirectory: string,
): Promise<string | null> {
  const segments = specifier.split("/");
  const packageName = specifier.startsWith("@")
    ? segments.slice(0, 2).join("/")
    : (segments[0] ?? "");
  if (!packageName) return null;
  const subpath = segments.slice(packageName.startsWith("@") ? 2 : 1).join("/");
  const packageRoot = await nearestPackageRoot(worktreeId, importerDirectory, packageName);
  if (!packageRoot) return null;
  const packageJsonPath = `${packageRoot}/package.json`;
  const raw = await readFile(worktreeId, packageJsonPath);
  if (raw.binary || raw.truncated) throw new Error(`${packageName}/package.json is not readable`);
  const pkg = JSON.parse(raw.text) as Package;
  const entryName = subpath ? `./${subpath}` : ".";
  const exported = resolve(pkg, entryName, {
    browser: true,
    conditions: [import.meta.env.DEV ? "development" : "production"],
  })?.[0];
  if (subpath && pkg.exports && !exported) {
    throw new Error(`${specifier} is not exported by installed package ${packageName}`);
  }
  if (subpath && !exported) {
    const direct = await resolveLocalFile(worktreeId, `${packageRoot}/${subpath}`);
    if (!direct) throw new Error(`Could not resolve ${specifier} from installed package`);
    return direct;
  }
  const browserFallback = legacy(pkg, { browser: true, fields: ["module", "main"] });
  const fallback =
    typeof browserFallback === "string"
      ? browserFallback
      : legacy(pkg, { browser: false, fields: ["module", "main"] });
  const entry = exported ?? (typeof fallback === "string" ? fallback : "index.js");
  const resolved = await resolveLocalFile(worktreeId, joinPath(packageRoot, entry));
  if (!resolved) throw new Error(`Could not resolve entry for installed package ${packageName}`);
  return resolved;
}

async function nearestPackageRoot(
  worktreeId: string,
  importerDirectory: string,
  packageName: string,
): Promise<string | null> {
  let directory = normalizePath(importerDirectory);
  while (true) {
    const root = joinPath(directory, "node_modules", packageName);
    // oxlint-disable-next-line no-await-in-loop -- Node resolution must choose nearest ancestor.
    if (await pathExists(worktreeId, `${root}/package.json`)) return root;
    if (!directory) return null;
    directory = dirname(directory);
  }
}

async function resolveLocalFile(worktreeId: string, path: string): Promise<string | null> {
  const normalized = normalizePath(path);
  const extensions = ["", ".tsx", ".ts", ".jsx", ".js", ".mjs", ".cjs", ".json", ".css"];
  const candidates = [
    ...extensions.map((extension) => `${normalized}${extension}`),
    ...extensions.map((extension) => `${normalized}/index${extension}`),
  ];
  for (const candidate of candidates) {
    // Resolution order is significant: exact path wins before extension/index fallbacks.
    // oxlint-disable-next-line no-await-in-loop
    if (candidate && (await readableLocalFile(worktreeId, candidate))) return candidate;
  }
  return null;
}

async function readableLocalFile(worktreeId: string, path: string): Promise<boolean> {
  try {
    const file = await readFile(worktreeId, path);
    return !file.binary && !file.truncated;
  } catch {
    return false;
  }
}

async function readText(
  worktreeId: string,
  path: string,
  cache: Map<string, string>,
): Promise<string> {
  const cached = cache.get(path);
  if (cached !== undefined) return cached;
  const file = await readFile(worktreeId, path);
  if (file.binary) throw new Error(`${path} is binary and cannot be imported`);
  if (file.truncated) throw new Error(`${path} is too large to import`);
  cache.set(path, file.text);
  return file.text;
}

function normalizePath(path: string): string {
  const output: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!output.pop()) throw new Error(`Import escapes worktree: ${path}`);
    } else {
      output.push(segment);
    }
  }
  return output.join("/");
}

function loaderFor(path: string): Loader {
  const extension = extname(new URL(path, "https://preview.invalid").pathname);
  if (extension === "tsx") return "tsx";
  if (extension === "ts") return "ts";
  if (extension === "jsx") return "jsx";
  if (extension === "json") return "json";
  if (extension === "css") return "css";
  return "js";
}

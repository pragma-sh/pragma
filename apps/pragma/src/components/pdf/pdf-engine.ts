import { useEffect, useState } from "react";

import { createPdfiumEngine } from "@embedpdf/engines/pdfium-worker-engine";
import { ignore, type PdfEngine } from "@embedpdf/models";
// Vite copies the wasm into the bundle and hands back its local URL. The engine
// otherwise fetches it from a CDN, which a desktop app must never depend on.
import pdfiumWasmUrl from "@embedpdf/pdfium/pdfium.wasm?url";

import { errorMessage } from "@/lib/errors";

/**
 * The wasm URL the engine's worker fetches, made absolute.
 *
 * This is load-bearing, not tidiness. The engine runs in a worker created from a
 * `blob:` URL, and a root-relative path has no meaningful base there: WebKit
 * rejects it with `TypeError: URL is not valid or contains user credentials.`
 * EmbedPDF swallows that failure, so the symptom is not an error but a document
 * that stays "opening" forever. Resolving against the page keeps it working in
 * dev (`http://localhost:1420/...`) and under Tauri's custom protocol alike.
 */
function absoluteWasmUrl(): string {
  return new URL(pdfiumWasmUrl, window.location.href).href;
}

/**
 * How long the engine survives with no viewers mounted. A pane renders only its
 * active tab, so switching tabs unmounts the viewer entirely — tearing the
 * engine down at zero references would make every switch back pay the wasm and
 * worker start-up again. Holding it briefly makes that switch instant while
 * still freeing the worker for a session that has moved on from PDFs.
 */
const ENGINE_IDLE_MS = 5 * 60 * 1000;

/**
 * The pdfium engine is a multi-megabyte WebAssembly module running in its own
 * worker, so every open PDF tab shares one instance. It is created by the first
 * viewer that asks for it — an app that never opens a PDF never pays for it —
 * and torn down `ENGINE_IDLE_MS` after the last one goes away.
 */
let enginePromise: Promise<PdfEngine> | null = null;
let refCount = 0;
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/** Returns the shared engine, creating it on first use, and takes a reference. */
function acquirePdfEngine(): Promise<PdfEngine> {
  refCount += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  enginePromise ??= (async () =>
    createPdfiumEngine(absoluteWasmUrl(), {
      // No network: missing fonts fall back to whatever pdfium embeds rather
      // than fetching font packs from a CDN.
      fontFallback: null,
    }))();
  return enginePromise;
}

/** Drops a reference, arming the idle teardown once nothing is using the engine. */
function releasePdfEngine(): void {
  refCount -= 1;
  if (refCount > 0 || idleTimer) return;
  idleTimer = setTimeout(() => {
    idleTimer = null;
    if (refCount > 0) return;
    const pending = enginePromise;
    enginePromise = null;
    void pending?.then((engine) => {
      engine.closeAllDocuments?.().wait(() => engine.destroy?.(), ignore);
      return undefined;
    }, ignore);
  }, ENGINE_IDLE_MS);
}

/** Lifecycle of the shared pdfium engine as one viewer sees it. */
export type PdfEngineState =
  | { kind: "loading" }
  | { kind: "ready"; engine: PdfEngine }
  | { kind: "error"; message: string };

/** Subscribes to the shared pdfium engine for as long as the component lives. */
export function usePdfEngine(): PdfEngineState {
  const [state, setState] = useState<PdfEngineState>({ kind: "loading" });

  useEffect(() => {
    let cancelled = false;
    setState({ kind: "loading" });
    void acquirePdfEngine()
      .then((engine) => {
        if (!cancelled) setState({ kind: "ready", engine });
        return undefined;
      })
      .catch((cause: unknown) => {
        if (!cancelled) setState({ kind: "error", message: errorMessage(cause) });
      });
    return () => {
      cancelled = true;
      releasePdfEngine();
    };
  }, []);

  return state;
}

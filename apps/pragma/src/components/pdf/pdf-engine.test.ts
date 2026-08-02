import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const createPdfiumEngineMock = vi.fn(
  (_wasmUrl: string, _options: { fontFallback: unknown }) => ({}),
);
vi.mock("@embedpdf/engines/pdfium-worker-engine", () => ({
  createPdfiumEngine: createPdfiumEngineMock,
}));
// Vite resolves this to a root-relative path in the real build.
vi.mock("@embedpdf/pdfium/pdfium.wasm?url", () => ({ default: "/assets/pdfium-abc123.wasm" }));

const { usePdfEngine } = await import("@/components/pdf/pdf-engine");

describe("usePdfEngine", () => {
  it("hands the worker an absolute wasm URL", async () => {
    const { result } = renderHook(() => usePdfEngine());

    await waitFor(() => expect(result.current.kind).toBe("ready"));
    const call = createPdfiumEngineMock.mock.calls[0];
    if (!call) throw new Error("the engine was never created");
    const [wasmUrl, options] = call;
    // A root-relative path has no base inside the engine's `blob:` worker —
    // WebKit rejects it and EmbedPDF swallows the failure, so the document just
    // never opens. Only an absolute URL survives the trip.
    expect(() => new URL(wasmUrl)).not.toThrow();
    expect(wasmUrl.endsWith("/assets/pdfium-abc123.wasm")).toBe(true);
    // Font fallback would otherwise reach for CDN font packs.
    expect(options.fontFallback).toBeNull();
  });
});

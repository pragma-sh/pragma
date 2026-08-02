import { useEffect, useState } from "react";

import { PdfStatus } from "@/components/pdf/PdfStatus";
import { Button } from "@/components/ui/button";

/**
 * How long a document may sit in "opening" before we stop pretending it is
 * merely slow.
 */
const STALL_MS = 20_000;

/**
 * The "opening" placeholder, with a way out. The engine reports parse failures
 * through its document state, but a worker that dies — or never fetches its
 * wasm — resolves nothing at all and reports nothing either, which would leave
 * this surface spinning forever. After `STALL_MS` it says so and offers a retry.
 */
export function PdfOpeningStatus({ name, onRetry }: { name: string; onRetry: () => void }) {
  const [stalled, setStalled] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => setStalled(true), STALL_MS);
    return () => clearTimeout(timer);
  }, []);

  if (!stalled) return <PdfStatus>Opening {name}…</PdfStatus>;

  return (
    <PdfStatus>
      <p>{name} is taking longer than expected to open.</p>
      <Button onClick={onRetry} size="sm" variant="ghost">
        Retry
      </Button>
    </PdfStatus>
  );
}

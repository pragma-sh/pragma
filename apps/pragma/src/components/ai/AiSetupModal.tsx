import { useCallback, useEffect, useState } from "react";

import { Sparkles } from "lucide-react";

import { AiAuthOptions } from "@/components/ai/AiAuthOptions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useAi } from "@/state/ai-context";

/**
 * Full-screen, non-dismissible setup modal shown on first run until the user
 * connects an AI provider or explicitly skips. It opens while Pragma AI onboarding
 * is incomplete (`needsSetup`) and stays open (via `sessionOpen`) after the first
 * connect so the user can add several providers before clicking Done. Done and Skip
 * both persist `ai.setupDismissed` so the modal never returns. Mounted once in
 * `App.tsx`.
 */
export function AiSetupModal() {
  const { status, needsSetup, dismissSetup } = useAi();
  const [sessionOpen, setSessionOpen] = useState(false);
  const [providerAuthScreenOpen, setProviderAuthScreenOpen] = useState(false);
  const hasAuthedProvider = (status?.signedIn.length ?? 0) > 0;

  // Latch the first-run prompt open so a successful connect (which clears
  // `needsSetup`) doesn't slam the modal shut mid "add another".
  useEffect(() => {
    if (needsSetup) {
      setSessionOpen(true);
    }
  }, [needsSetup]);

  const finish = useCallback(() => {
    setSessionOpen(false);
    void dismissSetup();
  }, [dismissSetup]);

  return (
    <Dialog open={needsSetup || sessionOpen}>
      <DialogContent
        className="max-w-md gap-6 py-8"
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-white/10">
            <Sparkles className="size-6" />
          </div>
          <DialogTitle className="text-base">Enable AI features</DialogTitle>
          <DialogDescription className="max-w-sm">
            Connect an AI provider to power commit messages and other AI helpers. You can use a
            subscription sign-in or paste an API key.
          </DialogDescription>
        </div>
        <AiAuthOptions onProviderAuthScreenChange={setProviderAuthScreenOpen} />
        {!providerAuthScreenOpen ? (
          <div className="flex gap-2">
            <Button
              className="flex-1"
              onClick={() => void dismissSetup()}
              size="sm"
              variant="outline"
            >
              Skip for now
            </Button>
            {hasAuthedProvider ? (
              <Button className="flex-1" onClick={finish} size="sm">
                Done
              </Button>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

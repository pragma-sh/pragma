import { Icon } from "@iconify/react";

import { GitHubAuthOptions } from "@/components/github/GitHubAuthOptions";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useGitHub } from "@/state/github-context";

/**
 * Full-screen, non-dismissible setup modal that gates the app on first run until
 * the user connects GitHub or explicitly skips. Shown only while `needsSetup`
 * (not authenticated and not previously dismissed). Skipping persists the choice
 * so the modal never returns. Mounted once in `App.tsx`.
 */
export function GitHubSetupModal() {
  const { needsSetup, dismissSetup } = useGitHub();

  return (
    <Dialog open={needsSetup}>
      <DialogContent
        className="max-w-md gap-6 py-8"
        // Non-dismissible: clicking outside or pressing Escape must not close it;
        // the only ways out are connecting GitHub or the explicit Skip link.
        onEscapeKeyDown={(event) => event.preventDefault()}
        onInteractOutside={(event) => event.preventDefault()}
        showCloseButton={false}
      >
        <div className="flex flex-col items-center gap-2 text-center">
          <div className="mb-2 inline-flex size-12 items-center justify-center rounded-full bg-muted">
            <Icon className="size-6" icon="simple-icons:github" />
          </div>
          <DialogTitle className="text-base">Connect Pragma to GitHub</DialogTitle>
          <DialogDescription className="max-w-sm">
            Manage pull requests, reviews, and merges without leaving your worktree.
          </DialogDescription>
        </div>
        <GitHubAuthOptions className="w-full" />
        <Button
          className="mx-auto h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => void dismissSetup()}
          variant="link"
        >
          Skip for now
        </Button>
      </DialogContent>
    </Dialog>
  );
}

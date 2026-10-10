import { useEffect, useState } from "react";
import { constants } from "@pragma-sh/constants";
import { Heart, PartyPopper, Share2, Star } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { isRepoStarred, starRepo } from "@/lib/github";
import { PRAGMA_REPO, pragmaShareTargets } from "@/lib/share-pragma";
import { browserOpenExternal } from "@/lib/tauri";
import { useGitHub } from "@/state/github-context";

/**
 * Where the GitHub star row stands: hidden while unknown or already starred,
 * a link when signed out, a one-click star when signed in, then a thank-you.
 */
type StarState = "checking" | "hidden" | "link" | "ready" | "starring" | "thanked";

/** Shown once after an update installs: confirms it and asks for a share or a star. */
export function UpdateSuccessDialog({
  version,
  onClose,
}: {
  version: string | null;
  onClose: () => void;
}) {
  const starState = useStarState(version !== null);
  return (
    <Dialog open={version !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg gap-5">
        <div className="flex items-start gap-4">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-full bg-muted">
            <PartyPopper className="size-5" />
          </div>
          <div className="min-w-0">
            <DialogTitle>Pragma updated successfully</DialogTitle>
            <DialogDescription className="mt-1">
              You're now running Pragma {version}.
            </DialogDescription>
          </div>
        </div>
        <div className="space-y-3">
          <p className="flex items-center gap-2 text-sm">
            <Heart className="size-4 shrink-0 text-muted-foreground" />
            Love using Pragma? The best way to help us grow is to share the project.
          </p>
          <div className="flex flex-wrap gap-2">
            {pragmaShareTargets().map((target) => (
              <Button
                key={target.id}
                size="sm"
                variant="outline"
                onClick={() => void browserOpenExternal(target.url)}
              >
                <Share2 />
                {target.label}
              </Button>
            ))}
          </div>
        </div>
        <StarRow state={starState.state} onStar={starState.star} />
        <div className="flex justify-end">
          <Button onClick={onClose}>Done</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StarRow({ state, onStar }: { state: StarState; onStar: () => void }) {
  if (state === "checking" || state === "hidden") return null;
  if (state === "thanked") {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Star className="size-4 shrink-0 fill-current" />
        Thanks for starring Pragma on GitHub!
      </p>
    );
  }
  if (state === "link") {
    return (
      <Button
        className="self-start"
        size="sm"
        variant="secondary"
        onClick={() => void browserOpenExternal(constants.github.homepageUrl)}
      >
        <Star />
        Star on GitHub
      </Button>
    );
  }
  return (
    <Button
      className="self-start"
      disabled={state === "starring"}
      size="sm"
      variant="secondary"
      onClick={onStar}
    >
      <Star />
      {state === "starring" ? "Starring…" : "Star on GitHub"}
    </Button>
  );
}

/**
 * Resolves the star row once the dialog opens. Signed in, it asks GitHub
 * whether the repository is already starred; any failure falls back to the
 * plain link so the row never disappears for the wrong reason.
 */
function useStarState(open: boolean): { state: StarState; star: () => void } {
  const { authenticated, loading } = useGitHub();
  const [state, setState] = useState<StarState>("checking");

  useEffect(() => {
    if (!open || loading) return;
    if (!authenticated) {
      setState("link");
      return;
    }
    let cancelled = false;
    setState("checking");
    isRepoStarred(PRAGMA_REPO)
      .then((starred) => !cancelled && setState(starred ? "hidden" : "ready"))
      .catch(() => !cancelled && setState("link"));
    return () => {
      cancelled = true;
    };
  }, [authenticated, loading, open]);

  function star() {
    setState("starring");
    starRepo(PRAGMA_REPO)
      .then(() => setState("thanked"))
      .catch(() => {
        // Starring needs a token scope the stored one may lack; let the
        // browser finish it instead.
        setState("link");
        void browserOpenExternal(constants.github.homepageUrl);
      });
  }

  return { state, star };
}

import { useState } from "react";

import { Check, ChevronDown, Zap } from "lucide-react";

import { System1ConnectionForm } from "@/components/ai/System1ConnectionForm";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { saveGlobalSystem1Settings } from "@/lib/system1-settings";
import { useSystem1Status } from "@/state/system1";

/**
 * The optional System 1 card at the top of the AI onboarding step. It is its
 * own card — separate from the provider sign-in below it — because it powers a
 * different thing (Auto in the agent pickers) and does not satisfy the step.
 */
export function System1OnboardingCard() {
  const status = useSystem1Status();
  const configured = status?.configured === true;
  const [open, setOpen] = useState(false);

  return (
    <Collapsible
      className="w-full rounded-lg border bg-card p-3 text-left"
      open={open}
      onOpenChange={setOpen}
    >
      <div className="flex items-start gap-2.5">
        <Zap className="mt-0.5 size-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">System 1 model · optional</p>
          <p className="text-xs text-muted-foreground">
            Add a Jev key and Auto picks the agent, model, and effort for every launch.
          </p>
        </div>
        {configured ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Check className="size-3.5 text-primary" /> Added
          </span>
        ) : (
          <CollapsibleTrigger asChild>
            <Button className="h-7 gap-1 px-2 text-xs" size="sm" variant="outline">
              Set up
              <ChevronDown className={open ? "size-3 rotate-180" : "size-3"} />
            </Button>
          </CollapsibleTrigger>
        )}
      </div>
      <CollapsibleContent className="pt-3">
        <System1ConnectionForm
          saveSettings={saveGlobalSystem1Settings}
          onSaved={() => setOpen(false)}
        />
      </CollapsibleContent>
    </Collapsible>
  );
}

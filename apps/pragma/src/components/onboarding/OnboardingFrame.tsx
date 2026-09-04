import { useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";

import { useOnboardingFlow } from "@/components/onboarding/onboarding-progress";
import { useOnboardingLayout } from "@/components/onboarding/use-onboarding-layout";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

/**
 * Shared layout for one onboarding step: an icon, a heading, supporting copy,
 * the step's own content, and the footer that moves through the flow.
 *
 * A step's primary action stays disabled until the step is actually done
 * (`nextDisabled`), so "Continue" never quietly means "and I did nothing".
 * Every step is still skippable — the footer offers the step's own skip, which
 * advances without doing the step's work, and a flow-wide "Skip setup" that
 * ends onboarding outright — so the flow can never trap a user behind a
 * sign-in or an install.
 *
 * A step with `media` (a preview clip) runs landscape while there is room for
 * it: the copy is a fixed column on the right and the clip takes every pixel
 * left of it, spanning the dialog's whole height — progress row and footer
 * included, which is why both are rendered here rather than around this
 * component. The copy column is fixed rather than a fraction so the panel grows
 * with the dialog.
 *
 * That only holds while the panel is at least as wide as the clip's own 16:9;
 * narrower and the clip starts banding, so `useOnboardingLayout` (which
 * measures that panel rather than guessing at a viewport breakpoint) flips the
 * step to a stacked layout: a full-width banner above the copy, in a dialog
 * that is itself taller and narrower. Stacked, the banner sits *inside* the
 * scrolling body — it scrolls away with the copy instead of being pinned, so a
 * tall step in a short window gives its space to the content. The clip is one
 * element in both layouts — never rendered twice — so it is fetched once, and
 * it letterboxes rather than crops in either.
 */
export function OnboardingFrame({
  children,
  description,
  footnote,
  icon,
  media,
  nextDisabled = false,
  nextLabel = "Continue",
  onBack,
  onNext,
  onSkip,
  skipLabel = "Skip",
  title,
}: {
  children?: ReactNode;
  description: string;
  /** Small print under the content — e.g. the GitHub security note. */
  footnote?: ReactNode;
  icon: ReactNode;
  /** Preview clip shown in the left panel on wide layouts, above the copy otherwise. */
  media?: ReactNode;
  /** True while the step's own work is unfinished; skipping is then the way on. */
  nextDisabled?: boolean;
  nextLabel?: string;
  /** Omitted on the first step. */
  onBack?: () => void;
  onNext: () => void;
  /** Omitted when the step's only action is to continue. */
  onSkip?: () => void;
  skipLabel?: string;
  title: string;
}) {
  const { bodyRef, columnRef, contentRef, progress, side, skipAll, split } = useFrameLayout(media);
  return (
    <div className={cn("flex min-h-0 flex-1", side ? "flex-row" : "flex-col")}>
      <SidePanel media={media} side={side} />
      <div
        className={cn("flex min-h-0 min-w-0 flex-col", side ? "w-[28rem] flex-none" : "flex-1")}
        ref={columnRef}
      >
        <StepProgress progress={progress} />
        <StepBody
          banner={media}
          bodyRef={bodyRef}
          contentRef={contentRef}
          description={description}
          footnote={footnote}
          icon={icon}
          side={side}
          split={split}
          title={title}
        >
          {children}
        </StepBody>
        <StepFooter
          nextDisabled={nextDisabled}
          nextLabel={nextLabel}
          onBack={onBack}
          onNext={onNext}
          onSkip={onSkip}
          onSkipAll={skipAll}
          skipLabel={skipLabel}
        />
      </div>
    </div>
  );
}

/**
 * Everything the frame needs to decide before it renders: which layout the step
 * is in, the flow's own chrome, and the refs that report the column's height.
 *
 * `split` is "this step has a clip at all" — the copy is left-aligned in both
 * media layouts — while `side` is the stronger "and there is room to put it
 * beside the copy", which only the side-by-side layout satisfies.
 */
function useFrameLayout(media: ReactNode) {
  const { orientation } = useOnboardingLayout();
  const flow = useOnboardingFlow();
  const split = media !== undefined;
  const refs = useReportedColumnHeight(flow?.reportContentHeight);
  return {
    ...refs,
    progress: flow?.progress,
    side: split && orientation === "side",
    skipAll: flow?.skipAll,
    split,
  };
}

/**
 * The clip beside the copy on a side-by-side step; nothing at all otherwise.
 *
 * The panel takes its width from the row's definite height at 16:9, so the clip
 * fills it exactly. `min-w-0` is load-bearing: a flex item's automatic minimum
 * size is otherwise its content's intrinsic size, and the content is a video,
 * so the panel would claim the clip's native width and push the copy column out
 * of the dialog.
 */
function SidePanel({ media, side }: { media?: ReactNode; side: boolean }) {
  if (!media || !side) return null;
  return (
    <div className="aspect-video h-full w-auto min-w-0 shrink-0 overflow-hidden border-r bg-muted">
      {media}
    </div>
  );
}

/** The flow's progress row, pinned above the scrolling body — absent outside a flow. */
function StepProgress({ progress }: { progress?: ReactNode }) {
  if (!progress) return null;
  return <div className="shrink-0 px-6 pt-5">{progress}</div>;
}

/**
 * The step's scrolling body: an optional stacked banner, then the heading, the
 * step's own content, and its footnote.
 *
 * Stacked, the banner is part of this scrolling body rather than pinned above
 * it: full width and exactly 16:9, so it scrolls out of the way when the copy
 * under it is taller than the dialog instead of holding a fixed share of a
 * short window.
 */
function StepBody({
  banner,
  bodyRef,
  children,
  contentRef,
  description,
  footnote,
  icon,
  side,
  split,
  title,
}: {
  banner?: ReactNode;
  bodyRef: RefObject<HTMLDivElement | null>;
  children?: ReactNode;
  contentRef: RefObject<HTMLDivElement | null>;
  description: string;
  footnote?: ReactNode;
  icon: ReactNode;
  side: boolean;
  split: boolean;
  title: string;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto" ref={bodyRef}>
      {banner && !side ? (
        <div className="aspect-video w-full shrink-0 overflow-hidden border-b bg-muted">
          {banner}
        </div>
      ) : null}
      {/* Only the side-by-side column is already a readable measure; the
        full-width layouts are wider than one, so they cap and centre.
        The body's padding lives here so the banner above stays full-bleed —
        `useReportedColumnHeight` measures this element, so it still counts. */}
      <div className={cn("px-6 pt-6 pb-4", !side && "mx-auto w-full max-w-2xl")} ref={contentRef}>
        <StepHeading description={description} icon={icon} split={split} title={title} />
        {children ? <div className="mt-5">{children}</div> : null}
        {footnote ? (
          <div className="text-muted-foreground mt-5 text-xs leading-5">{footnote}</div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * Watches the step's copy column and reports the height it would take if
 * nothing clipped it: the column's fixed chrome (progress row, footer) plus the
 * natural height of the body's copy, padding included — the padding is on the
 * measured element rather than on the scroll body, so a stacked banner can be
 * full-bleed inside that same scroll body.
 *
 * A stacked banner is deliberately *not* part of the reported height:
 * `dialogBox` adds it back from the dialog's own width at 16:9.
 *
 * It reports the *content's* height rather than the column's, because the
 * column is exactly as tall as the dialog makes it — measuring that would only
 * ever hand back the size the dialog already has. A `ResizeObserver` on the
 * content picks up a step whose content arrives late (auth methods, a plugin
 * probe) without polling.
 */
function useReportedColumnHeight(report: ((px: number) => void) | undefined) {
  const bodyRef = useRef<HTMLDivElement>(null);
  const columnRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    const column = columnRef.current;
    const content = contentRef.current;
    if (!body || !column || !content || !report) return;

    function measure() {
      if (!body || !column || !content) return;
      const chrome = column.clientHeight - body.clientHeight;
      report?.(chrome + content.getBoundingClientRect().height);
    }

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(content);
    return () => observer.disconnect();
  }, [report]);

  return { bodyRef, columnRef, contentRef };
}

/** The step's icon, title, and supporting copy — centred unless a media panel is beside it. */
function StepHeading({
  description,
  icon,
  split,
  title,
}: {
  description: string;
  icon: ReactNode;
  split: boolean;
  title: string;
}) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2",
        split ? "items-start text-left" : "items-center text-center",
      )}
    >
      <div className="mb-1 inline-flex size-12 items-center justify-center rounded-full bg-muted">
        {icon}
      </div>
      <h2 className="text-base font-semibold">{title}</h2>
      <p className={cn("text-muted-foreground text-sm", !split && "max-w-md")}>{description}</p>
    </div>
  );
}

/**
 * Back on the left; every way out of the current step on the right — the
 * flow-wide skip, the step's own skip, then its primary action.
 *
 * The right-hand column is only `28rem` on a step with a media panel, so three
 * equal-weight buttons neither fit nor read as a hierarchy. "Skip setup" is a
 * muted link rather than a third button, every label is short and unwrappable,
 * and the row wraps as a whole instead of letting a button spill out of the
 * dialog.
 */
function StepFooter({
  nextDisabled,
  nextLabel,
  onBack,
  onNext,
  onSkip,
  onSkipAll,
  skipLabel,
}: {
  nextDisabled: boolean;
  nextLabel: string;
  onBack?: () => void;
  onNext: () => void;
  onSkip?: () => void;
  onSkipAll?: () => void;
  skipLabel: string;
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t bg-background px-6 py-4">
      <div>
        {onBack ? (
          <Button className="shrink-0" onClick={onBack} size="sm" variant="ghost">
            Back
          </Button>
        ) : null}
      </div>
      <div className="ml-auto flex items-center gap-2">
        {onSkipAll ? (
          <Button
            className="text-muted-foreground h-8 shrink-0 px-2 text-xs whitespace-nowrap"
            onClick={onSkipAll}
            size="sm"
            variant="link"
          >
            Skip setup
          </Button>
        ) : null}
        {onSkip ? (
          <Button className="shrink-0 whitespace-nowrap" onClick={onSkip} size="sm" variant="ghost">
            {skipLabel}
          </Button>
        ) : null}
        <Button
          className="shrink-0 whitespace-nowrap"
          disabled={nextDisabled}
          onClick={onNext}
          size="sm"
        >
          {nextLabel}
        </Button>
      </div>
    </div>
  );
}

"use client";

import { useMemo, useRef } from "react";
import Image from "next/image";
import Link from "next/link";
import { motion, useReducedMotion } from "motion/react";
import { ArrowRight, Download } from "lucide-react";

import { Button } from "@/components/ui/button";
import { AgentChipField } from "./agent-chip-field";
import { AGENT_BRANDS } from "./agents";

/** Agents the headline names outright; the rest are counted. */
const NAMED_AGENTS = 3;
/** How many integrations the headline's "+ others" stands for. */
const NAMED_OVERFLOW = AGENT_BRANDS.length - NAMED_AGENTS;

/** Landing hero: headline, download CTA, the 3D agent field, and the app shot. */
export function Hero() {
  const reduceMotion = useReducedMotion();
  const shotRef = useRef<HTMLDivElement>(null);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const subheadRef = useRef<HTMLParagraphElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const noteRef = useRef<HTMLParagraphElement>(null);
  // Each block of copy is protected on its own rather than as one column box.
  // The column is centre-aligned and as wide as its `max-w`, so protecting it
  // whole hands the field a rectangle far wider than anything painted in it —
  // and a band with nothing to curve around sits in a flat row on the heading.
  // Per-block (and, inside a block, per-line) rectangles give the chips the
  // heading's real silhouette to bend around.
  const protectedRefs = useMemo(() => [headingRef, subheadRef, actionsRef, noteRef, shotRef], []);

  // The chips seat in a band arcing over the copy until the hero is wide enough
  // for side gutters that hold a column, so the hero reserves the depth that
  // band needs — but only that depth, since any more of it reads as an empty
  // strip under the nav rather than as room for the field. The screenshot is
  // 1225px wide and a column needs roughly 370px beside it, so the gutters only
  // win past ~1960.
  return (
    <section className="relative z-10 isolate px-6 pt-36 pb-40 min-[1960px]:pt-24 min-[1960px]:pb-40">
      {/*
        The field is draggable, so it keeps pointer events; sitting at -z-10 it
        is painted (and hit-tested) below every element of the hero. The nav is
        `sticky`, so it takes its own space above this section and only overlays
        the hero once the page scrolls — the inset is therefore a small
        breathing gap, not the nav's height. It stays small on purpose: below
        the side gutters the chips seat in one band arcing over the heading, and
        every pixel spent here comes straight out of that band's depth.
      */}
      <AgentChipField
        className="absolute inset-x-0 top-6 bottom-0 -z-10"
        exclusionRefs={protectedRefs}
      />

      <div className="mx-auto flex max-w-5xl flex-col items-center text-center">
        <motion.h1
          ref={headingRef}
          initial={reduceMotion ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
          className="font-heading type-display-xxl mt-5 text-balance"
        >
          Run teams of coding agents in <span className="text-gradient-animated">parallel</span>
        </motion.h1>

        <motion.p
          ref={subheadRef}
          initial={reduceMotion ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.08, ease: [0.16, 1, 0.3, 1] }}
          // No `max-w`/`text-balance` here: both forced the one-sentence subhead
          // to break, and the line reads as one statement under the headline.
          // It still wraps on its own below ~700px.
          className="text-muted-foreground mt-7 text-lg leading-[1.3]"
        >
          Orchestrate Claude Code, Codex, OpenCode, and {NAMED_OVERFLOW}+ each in their own
          worktree.
        </motion.p>

        <motion.div
          ref={actionsRef}
          initial={reduceMotion ? false : { opacity: 0, y: 18 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.16, ease: [0.16, 1, 0.3, 1] }}
          className="mt-9 flex flex-wrap items-center justify-center gap-3"
        >
          <Button className="pill-cta gap-2">
            <Download className="size-4" />
            Download for macOS
          </Button>
          <Button asChild variant="secondary" className="pill-cta gap-2">
            <Link href="/docs">
              Read the docs
              <ArrowRight className="size-4" />
            </Link>
          </Button>
        </motion.div>

        <p ref={noteRef} className="text-muted-foreground mt-5 text-xs">
          macOS, Linux, and Windows. Local, over SSH, or inside WSL.
        </p>
      </div>

      <motion.div
        initial={reduceMotion ? false : { opacity: 0, y: 120, rotateX: 14, scale: 0.94 }}
        animate={{ opacity: 1, y: 0, rotateX: 0, scale: 1 }}
        transition={{ duration: 1.1, delay: 0.2, ease: [0.16, 1, 0.3, 1] }}
        style={{ perspective: 1600 }}
        className="relative mx-auto mt-12 w-full max-w-[1225px]"
      >
        <div
          ref={shotRef}
          className="border-border bg-card shadow-floating relative overflow-hidden rounded-xl border"
        >
          <Image
            src="/pragma-app.png"
            alt="The Pragma desktop app running ten coding agents in parallel worktrees"
            width={5104}
            height={2612}
            priority
            className="w-full"
          />
        </div>
        {/*
          Reflection. The copy is anchored to the top of a window 46% of the
          shot's height, so flipping it about its own centre lands the shot's
          bottom edge exactly on the seam. It runs past the hero's own box and
          on into the section below, which is why the section no longer clips.
        */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-0 top-full h-[46%] overflow-hidden [mask-image:linear-gradient(to_bottom,#000,transparent_70%)]"
        >
          <Image
            src="/pragma-app.png"
            alt=""
            width={5104}
            height={2612}
            aria-hidden
            className="absolute inset-x-0 top-0 w-full -scale-y-100 opacity-35 blur-[2px]"
          />
        </div>
      </motion.div>
    </section>
  );
}

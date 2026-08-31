"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { motion, useReducedMotion } from "motion/react";
import { Check } from "lucide-react";

import { cn } from "@/lib/utils";

/** Fades content in the first time it scrolls into view. */
export function Reveal({
  children,
  className,
  delay = 0,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
}) {
  const reduceMotion = useReducedMotion();

  return (
    <motion.div
      className={className}
      initial={reduceMotion ? false : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, margin: "-80px" }}
      transition={{ duration: 0.6, delay, ease: [0.16, 1, 0.3, 1] }}
    >
      {children}
    </motion.div>
  );
}

/**
 * Shared outer wrapper: the canvas ground and the top hairline.
 *
 * Every section stands on `{colors.canvas}`. `DESIGN.md` is explicit that the
 * dark canvas *is* the whitespace — rooms are separated by what stands on the
 * ground (a grid of charcoal cards, a gradient panel, a bordered table), never
 * by tinting the ground itself, and never by a decorative backdrop. There is no
 * section numeral either: the landing sections are a set of capabilities, not an
 * ordered process.
 */
export function SectionShell({
  id,
  className,
  children,
}: {
  id?: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className={cn(
        "border-border relative isolate overflow-hidden border-t px-6 py-20 sm:py-24",
        className,
      )}
    >
      {children}
    </section>
  );
}

/** Frame shapes the landing media frame supports, and the class each maps to. */
const ASPECT_CLASS = {
  video: "aspect-video",
  wide: "aspect-[21/9]",
  portrait: "aspect-[9/16]",
  square: "aspect-square",
} as const;

/** Frame shape; the phone and the wide band need something other than 16:9. */
export type MediaAspect = keyof typeof ASPECT_CLASS;

function MediaFrame({
  className,
  aspect,
  children,
}: {
  className?: string;
  aspect?: MediaAspect;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "border-border bg-card shadow-raised relative flex w-full items-center justify-center overflow-hidden rounded-xl border",
        aspect && ASPECT_CLASS[aspect],
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A looping screen recording presented in the shared landing-page media frame. */
export function MediaVideo({
  src,
  className,
  aspect,
}: {
  src: string;
  className?: string;
  /** Frame shape; the phone and the wide band need something other than 16:9. */
  aspect?: MediaAspect;
}) {
  const reduceMotion = useReducedMotion();
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isNearViewport, setIsNearViewport] = useState(false);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsNearViewport(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!isNearViewport) return;
    const node = videoRef.current;
    if (!node) return;

    node.load();
    if (!reduceMotion) {
      void node.play();
    }
  }, [isNearViewport, reduceMotion]);

  return (
    <MediaFrame className={cn("md:scale-105 lg:scale-110", className)} aspect={aspect}>
      <video
        ref={videoRef}
        aria-hidden
        className="block h-auto w-full"
        loop
        muted
        playsInline
        preload="none"
        tabIndex={-1}
      >
        {isNearViewport ? <source src={src} type="video/mp4" /> : null}
      </video>
    </MediaFrame>
  );
}

/** A product screenshot presented in the shared landing-page media frame. */
export function MediaImage({
  src,
  alt,
  width,
  height,
  className,
}: {
  src: string;
  alt: string;
  width: number;
  height: number;
  className?: string;
}) {
  return (
    <MediaFrame className={className}>
      <Image
        src={src}
        alt={alt}
        width={width}
        height={height}
        sizes="(min-width: 1024px) 56vw, 100vw"
        className="h-auto w-full"
      />
    </MediaFrame>
  );
}

/**
 * Section heading + supporting copy, used above every feature block.
 *
 * The display tier follows the alignment rather than a prop of its own: a
 * left-aligned heading sits in the feature run's 5-column well and takes
 * `{typography.display-md}`, while a centred one spans the whole container and
 * can carry `{typography.display-lg}`. Both keep the -5%/-3% tracking that is
 * the brand signature (`DESIGN.md` → Typography → Principles).
 */
export function SectionHeading({
  title,
  description,
  align = "left",
  className,
}: {
  title: string;
  description?: ReactNode;
  align?: "left" | "center";
  className?: string;
}) {
  return (
    <div className={cn("max-w-2xl", align === "center" && "mx-auto text-center", className)}>
      <h2
        className={cn(
          "font-heading text-balance",
          align === "center" ? "type-display-lg" : "type-display-md",
        )}
      >
        {title}
      </h2>
      {description ? (
        <p className="text-muted-foreground mt-5 text-lg leading-[1.3]">{description}</p>
      ) : null}
    </div>
  );
}

/**
 * A single point in a feature list.
 *
 * There is exactly one style. The page used to draw these three different ways
 * depending on the enclosing layout, so the same kind of content changed shape
 * from section to section for no reason a reader could follow.
 */
export function FeaturePoint({ title, children }: { title: string; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <Check className="text-foreground mt-0.5 size-4 shrink-0" />
      <span className="text-sm leading-relaxed">
        <span className="text-foreground font-medium">{title}</span>{" "}
        <span className="text-muted-foreground">{children}</span>
      </span>
    </li>
  );
}

interface FeatureSectionProps {
  title: string;
  description: ReactNode;
  points: ReactNode;
  media: ReactNode;
  /** Optional quiet atmosphere behind section content. */
  background?: ReactNode;
  /** Puts the media on the left instead of the right. */
  flip?: boolean;
  id?: string;
  /** Applied to the section shell, e.g. to drop the top hairline. */
  className?: string;
}

/**
 * A feature section: copy and points in one column, media in the other.
 *
 * There is one layout, and `flip` is the only thing that varies between
 * sections — the page alternates it so the media walks right, left, right down
 * the page. Earlier revisions offered several layouts and cycled them so that no
 * two neighbours matched; uniformity reads better than variety here.
 */
export function FeatureSection({
  id,
  title,
  description,
  points,
  media,
  background,
  flip,
  className,
}: FeatureSectionProps) {
  return (
    <SectionShell id={id} className={className}>
      {background ? (
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0 overflow-hidden">
          {background}
        </div>
      ) : null}
      <div className="relative z-10 mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-12 lg:gap-16">
        <Reveal className={cn("lg:col-span-5", flip && "lg:order-2 lg:col-start-8")}>
          <SectionHeading title={title} description={description} />
          <ul className="mt-8 space-y-4">{points}</ul>
        </Reveal>
        <Reveal
          delay={0.08}
          className={cn("lg:col-span-7", flip && "lg:order-1 lg:col-start-1 lg:row-start-1")}
        >
          {media}
        </Reveal>
      </div>
    </SectionShell>
  );
}

import type { ReactNode } from "react";
import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { Video } from "@remotion/media";
import { AbsoluteFill, Easing, interpolate, Series, staticFile, useCurrentFrame } from "remotion";

const { fontFamily: headingFont } = loadGeist("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
});
const { fontFamily: bodyFont } = loadInter("normal", {
  weights: ["400", "500"],
  subsets: ["latin"],
});

const colors = {
  canvas: "#090909",
  ink: "#ffffff",
  muted: "#999999",
  slideCanvas: "#ffffff",
  slideInk: "#000000",
  gradientMagenta: "#d44df0",
  gradientViolet: "#6a4cf5",
  gradientBlue: "#2f6bff",
} as const;

const frames = {
  open: 105,
  statement: 75,
  worktrees: 847,
  fanout: 1550,
  agentBoard: 1369,
  github: 916,
  close: 105,
} as const;

export const PRAGMA_LAUNCH_DURATION_IN_FRAMES =
  frames.open +
  frames.statement * 4 +
  frames.worktrees +
  frames.fanout +
  frames.agentBoard +
  frames.github +
  frames.close;

function Statement({ children }: { children: ReactNode }) {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        backgroundColor: colors.slideCanvas,
        color: colors.slideInk,
        fontFamily: bodyFont,
        alignItems: "center",
        justifyContent: "center",
        padding: "0 120px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          opacity: interpolate(frame, [4, 20], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          }),
          translate: `0 ${interpolate(frame, [4, 22], [44, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1600,
            fontFamily: headingFont,
            fontSize: 158,
            fontWeight: 400,
            lineHeight: 0.88,
            letterSpacing: "-0.055em",
          }}
        >
          {children}
        </div>
      </div>
    </AbsoluteFill>
  );
}

function ProductClip({ src }: { src: string }) {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.canvas, overflow: "hidden" }}>
      <Video
        src={staticFile(src)}
        muted
        style={{ width: "100%", height: "100%", objectFit: "contain" }}
      />
    </AbsoluteFill>
  );
}

function Open() {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        justifyContent: "center",
        backgroundColor: colors.slideCanvas,
        color: colors.slideInk,
        fontFamily: bodyFont,
        alignItems: "center",
        padding: "0 96px",
        textAlign: "center",
      }}
    >
      <div
        style={{
          opacity: interpolate(frame, [6, 24], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: `0 ${interpolate(frame, [6, 26], [42, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        <div
          style={{
            maxWidth: 1680,
            fontFamily: headingFont,
            fontSize: 166,
            fontWeight: 400,
            lineHeight: 0.88,
            letterSpacing: "-0.055em",
            textAlign: "center",
          }}
        >
          Run coding agents
          <br />
          <span
            style={{
              background: `linear-gradient(90deg, ${colors.gradientMagenta}, ${colors.gradientViolet}, ${colors.gradientBlue})`,
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            in parallel.
          </span>
        </div>
        <div style={{ marginTop: 38, color: colors.muted, fontSize: 34, letterSpacing: "-0.02em" }}>
          One workspace for every agent, worktree, and result.
        </div>
      </div>
    </AbsoluteFill>
  );
}

function Close() {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill
      style={{
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: colors.slideCanvas,
        color: colors.slideInk,
        fontFamily: bodyFont,
        textAlign: "center",
      }}
    >
      <div
        style={{
          opacity: interpolate(frame, [5, 22], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
          }),
          translate: `0 ${interpolate(frame, [5, 24], [36, 0], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(0.16, 1, 0.3, 1),
          })}px`,
        }}
      >
        <div
          style={{
            fontFamily: headingFont,
            fontSize: 142,
            fontWeight: 400,
            lineHeight: 0.9,
            letterSpacing: "-0.055em",
          }}
        >
          Build more.
          <br />
          Orchestrate less.
        </div>
        <div style={{ marginTop: 42, color: colors.muted, fontSize: 28, fontWeight: 500 }}>
          pragma-app.sh
        </div>
      </div>
    </AbsoluteFill>
  );
}

/** Minimal launch film alternating full-screen claims with full-screen product proof. */
export function PragmaLaunch() {
  return (
    <AbsoluteFill style={{ backgroundColor: colors.canvas }}>
      <Series>
        <Series.Sequence name="Open" durationInFrames={frames.open}>
          <Open />
        </Series.Sequence>

        <Series.Sequence name="Worktrees statement" durationInFrames={frames.statement}>
          <Statement>Create an isolated worktree.</Statement>
        </Series.Sequence>
        <Series.Sequence name="Worktrees proof" durationInFrames={frames.worktrees}>
          <ProductClip src="media/worktrees.mp4" />
        </Series.Sequence>

        <Series.Sequence name="Fanout statement" durationInFrames={frames.statement}>
          <Statement>Race agents on the same prompt.</Statement>
        </Series.Sequence>
        <Series.Sequence name="Fanout proof" durationInFrames={frames.fanout}>
          <ProductClip src="media/fanout.mp4" />
        </Series.Sequence>

        <Series.Sequence name="Agent board statement" durationInFrames={frames.statement}>
          <Statement>Prompt from one board.</Statement>
        </Series.Sequence>
        <Series.Sequence name="Agent board proof" durationInFrames={frames.agentBoard}>
          <ProductClip src="media/agent-board.mp4" />
        </Series.Sequence>

        <Series.Sequence name="GitHub statement" durationInFrames={frames.statement}>
          <Statement>Review pull requests in place.</Statement>
        </Series.Sequence>
        <Series.Sequence name="GitHub proof" durationInFrames={frames.github}>
          <ProductClip src="media/github.mp4" />
        </Series.Sequence>

        <Series.Sequence name="Close" durationInFrames={frames.close}>
          <Close />
        </Series.Sequence>
      </Series>
    </AbsoluteFill>
  );
}

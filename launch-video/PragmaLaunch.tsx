import { loadFont as loadGeist } from "@remotion/google-fonts/Geist";
import { loadFont as loadInter } from "@remotion/google-fonts/Inter";
import { Audio, Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  Series,
  staticFile,
  useCurrentFrame,
} from "remotion";

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
  statement: 105,
  worktrees: 847,
  fanout: 1550,
  agentBoard: 1369,
  github: 916,
  close: 105,
} as const;

const cornerAgents = [
  {
    name: "Claude Code",
    logo: staticFile("agents/claude-code.svg"),
    position: { top: 76, left: 84 },
    rotation: -8,
    phase: 0,
  },
  {
    name: "Codex",
    logo: staticFile("agents/codex.png"),
    position: { top: 76, right: 84 },
    rotation: 7,
    phase: 13,
  },
  {
    name: "OpenCode",
    logo: staticFile("agents/opencode.svg"),
    position: { bottom: 76, left: 84 },
    rotation: 6,
    phase: 27,
  },
  {
    name: "Cursor",
    logo: staticFile("agents/cursor.svg"),
    position: { right: 84, bottom: 76 },
    rotation: -7,
    phase: 41,
  },
] as const;

export const PRAGMA_LAUNCH_DURATION_IN_FRAMES =
  frames.open +
  frames.statement * 4 +
  frames.worktrees +
  frames.fanout +
  frames.agentBoard +
  frames.github +
  frames.close;

function CornerAgentChips({ animate = true }: { animate?: boolean }) {
  const frame = useCurrentFrame();

  return (
    <AbsoluteFill style={{ pointerEvents: "none" }}>
      {cornerAgents.map((agent, index) => {
        const entrance = animate
          ? interpolate(frame, [index * 3, index * 3 + 18], [0, 1], {
              extrapolateLeft: "clamp",
              extrapolateRight: "clamp",
              easing: Easing.out(Easing.cubic),
            })
          : 1;
        const floatX = Math.sin((frame + agent.phase) / 24) * 8;
        const floatY = Math.cos((frame + agent.phase) / 21) * 10;
        const turn = agent.rotation + Math.sin((frame + agent.phase) / 30) * 2.5;

        return (
          <div
            key={agent.name}
            style={{
              ...agent.position,
              position: "absolute",
              width: 118,
              height: 118,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              overflow: "hidden",
              border: "1px solid rgba(255, 255, 255, 0.12)",
              borderRadius: 31,
              background: "linear-gradient(145deg, #25262b 0%, #0f1013 72%)",
              boxShadow:
                "0 30px 54px rgba(15, 16, 19, 0.2), inset 0 1px 1px rgba(255, 255, 255, 0.18), inset 0 -5px 12px rgba(0, 0, 0, 0.36)",
              opacity: entrance,
              transform: `translate3d(${floatX}px, ${floatY - (1 - entrance) * 38}px, 0) rotate(${turn}deg) scale(${0.82 + entrance * 0.18})`,
            }}
          >
            <Img
              src={agent.logo}
              alt={agent.name}
              style={{ width: 78, height: 78, objectFit: "contain" }}
            />
          </div>
        );
      })}
    </AbsoluteFill>
  );
}

function Statement({ children, subtitle }: { children: string; subtitle?: string }) {
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
      <CornerAgentChips />
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
        {subtitle ? (
          <div
            style={{
              marginTop: 40,
              color: colors.muted,
              fontFamily: bodyFont,
              fontSize: 36,
              fontWeight: 400,
              letterSpacing: "-0.02em",
            }}
          >
            {subtitle}
          </div>
        ) : null}
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
      <CornerAgentChips animate={false} />
      <div>
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
          Orchestrate Claude Code, Codex, OpenCode, and 7+ more, each in their own worktree.
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
      <CornerAgentChips />
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
          Stop babysitting one agent at a time.
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
          <Statement subtitle="Nested worktrees are supported.">Create a worktree.</Statement>
        </Series.Sequence>
        <Series.Sequence name="Worktrees proof" durationInFrames={frames.worktrees}>
          <ProductClip src="media/worktrees.mp4" />
        </Series.Sequence>

        <Series.Sequence name="Fanout statement" durationInFrames={frames.statement}>
          <Statement subtitle="Compare and pick your favorite result.">
            Race agents against each other.
          </Statement>
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
          <Statement subtitle="View comments and fix issues without leaving Pragma.">
            Open a PR.
          </Statement>
        </Series.Sequence>
        <Series.Sequence name="GitHub proof" durationInFrames={frames.github}>
          <ProductClip src="media/github.mp4" />
        </Series.Sequence>

        <Series.Sequence name="Close" durationInFrames={frames.close}>
          <Close />
        </Series.Sequence>
      </Series>
      <Audio
        src={staticFile("media/pragma-lofi.wav")}
        loop
        volume={(frame) =>
          interpolate(
            frame,
            [0, 45, PRAGMA_LAUNCH_DURATION_IN_FRAMES - 75, PRAGMA_LAUNCH_DURATION_IN_FRAMES],
            [0, 0.35, 0.35, 0],
            { extrapolateLeft: "clamp", extrapolateRight: "clamp" },
          )
        }
      />
    </AbsoluteFill>
  );
}

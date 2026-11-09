import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowUpRight, Minus, MousePointer2, Pause, Play, Square } from "lucide-react";
import { toast } from "sonner";

import { constants, type ComputerScreenshot, type ComputerSession } from "@pragma-sh/constants";

import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { useComputerPermissions } from "@/hooks/use-computer-permissions";
import { errorMessage } from "@/lib/errors";
import { computerRpc, streamComputerFrames } from "@/lib/tauri";
import { cn } from "@/lib/utils";
import {
  minimizeComputerPip,
  revealComputerPip,
  useComputerPipMinimized,
} from "@/state/computer-pip-store";
import {
  controlledApps,
  controlSession,
  useComputerUse,
  type ComputerCursor,
} from "@/state/computer-use-store";

/** Panel sizes in CSS pixels. */
const PANEL_SIZE = { width: 320, height: 236 };
/** Distance kept from the window edges. */
const MARGIN = 16;

/**
 * The in-app picture-in-picture panel for the selected worktree's
 * computer-use sessions: a live view of the app an agent is driving, who is
 * driving it, what it is doing, and the controls to pause or stop it.
 *
 * It floats inside the Pragma window only — never as a separate OS window —
 * and can be dragged anywhere in it by its header. Minimize collapses it to a
 * pill (the sidebar badge brings it back); the arrow brings the previewed app
 * to the front.
 */
export function ComputerPip({ sessions }: { sessions: ComputerSession[] }) {
  const { cursors } = useComputerUse();
  const minimized = useComputerPipMinimized();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const session = sessions.find((s) => s.id === selectedId) ?? sessions[0] ?? null;
  const cursor = session ? cursors[session.id] : undefined;
  const size = PANEL_SIZE;
  const { position, startDrag } = useDraggable(size);
  const { frame, failure } = useFrame(
    minimized ? null : (session?.id ?? null),
    constants.computer.pipFrameWidth,
  );

  if (!session) return null;
  if (minimized) {
    return (
      <button
        className="fixed right-4 bottom-4 z-50 flex max-w-72 items-center gap-2 rounded-full border bg-background px-3 py-1.5 text-xs shadow-lg"
        data-testid="computer-pip-pill"
        onClick={revealComputerPip}
        type="button"
      >
        <MousePointer2 className="size-3.5 shrink-0 animate-pulse text-primary" />
        <span className="truncate">
          {session.owner.label ?? "Agent"} · {controlledApps(session)}
        </span>
      </button>
    );
  }

  return (
    <div
      className="fixed z-50 flex flex-col overflow-hidden rounded-xl border bg-background text-foreground shadow-2xl"
      data-testid="computer-pip"
      style={{ left: position.x, top: position.y, width: size.width, height: size.height }}
    >
      <PipHeader
        onPointerDown={startDrag}
        session={session}
        sessions={sessions}
        setSelectedId={setSelectedId}
      />
      <div className="relative min-h-0 flex-1 overflow-hidden bg-muted">
        {frame ? <PipFrame cursor={cursor} frame={frame} /> : <PipPlaceholder failure={failure} />}
        {session.paused ? (
          <div className="absolute inset-x-0 bottom-0 bg-warning/90 px-3 py-1 text-center text-xs font-medium text-background">
            {pauseMessage(session)}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2 border-t px-3 py-1.5 text-xs">
        <MousePointer2 className="size-3 shrink-0 text-primary" />
        <span className="min-w-0 flex-1 truncate">{sessionDescription(session, cursor)}</span>
        <span className="shrink-0 text-muted-foreground">{session.actionCount} steps</span>
      </div>
    </div>
  );
}

function pauseMessage(session: ComputerSession): string {
  return session.pauseReason === "stopped"
    ? "Task stopped — restart to continue"
    : "Task paused — you're in control";
}

function sessionDescription(session: ComputerSession, cursor: ComputerCursor | undefined): string {
  if (session.paused) return session.pauseReason === "stopped" ? "Task stopped" : "Task paused";
  return cursor?.description ?? session.lastDescription ?? "Idle";
}

/**
 * Keeps the panel inside the window: it starts in the bottom-right corner,
 * follows the pointer while its header is dragged, and is clamped back in
 * whenever its size or the window changes.
 */
function useDraggable(size: { width: number; height: number }) {
  const [position, setPosition] = useState(() => cornerPosition(size));
  const drag = useRef<{ dx: number; dy: number } | null>(null);

  useEffect(() => {
    const clamp = () => setPosition((current) => clampPosition(current, size));
    clamp();
    window.addEventListener("resize", clamp);
    return () => window.removeEventListener("resize", clamp);
  }, [size]);

  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if ((event.target as HTMLElement).closest("button")) return;
    drag.current = { dx: event.clientX - position.x, dy: event.clientY - position.y };
    const move = (moveEvent: PointerEvent) => {
      const offset = drag.current;
      if (!offset) return;
      setPosition(
        clampPosition({ x: moveEvent.clientX - offset.dx, y: moveEvent.clientY - offset.dy }, size),
      );
    };
    const up = () => {
      drag.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { position, startDrag };
}

function cornerPosition(size: { width: number; height: number }) {
  return clampPosition(
    { x: window.innerWidth - size.width - MARGIN, y: window.innerHeight - size.height - MARGIN },
    size,
  );
}

/** Keeps a panel of `size` at `point` fully inside the window. */
export function clampPosition(
  point: { x: number; y: number },
  size: { width: number; height: number },
  bounds = { width: window.innerWidth, height: window.innerHeight },
): { x: number; y: number } {
  const maxX = Math.max(MARGIN, bounds.width - size.width - MARGIN);
  const maxY = Math.max(MARGIN, bounds.height - size.height - MARGIN);
  return {
    x: Math.min(Math.max(point.x, MARGIN), maxX),
    y: Math.min(Math.max(point.y, MARGIN), maxY),
  };
}

function PipHeader({
  onPointerDown,
  session,
  sessions,
  setSelectedId,
}: {
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  session: ComputerSession;
  sessions: ComputerSession[];
  setSelectedId: (id: string) => void;
}) {
  const run = (op: "pause" | "unpause" | "stop" | "focusSession") => {
    void controlSession(op, session.id).catch((error: unknown) => toast.error(errorMessage(error)));
  };
  return (
    <div
      className="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1 border-b px-2 select-none active:cursor-grabbing"
      onPointerDown={onPointerDown}
    >
      <div className="min-w-0 flex-1 truncate text-xs">
        {sessions.length > 1 ? (
          <span className="flex gap-1">
            {sessions.map((s) => (
              <button
                className={cn(
                  "truncate rounded px-1.5 py-0.5",
                  s.id === session.id ? "bg-muted font-medium" : "text-muted-foreground",
                )}
                key={s.id}
                onClick={() => setSelectedId(s.id)}
                type="button"
              >
                {s.owner.label ?? "Agent"}
              </button>
            ))}
          </span>
        ) : (
          <span>
            <span className="font-medium">{session.owner.label ?? "Agent"}</span>
            <span className="text-muted-foreground"> · {controlledApps(session)}</span>
          </span>
        )}
      </div>
      {session.paused ? (
        <IconButton
          label={session.pauseReason === "stopped" ? "Restart" : "Resume"}
          onClick={() => run("unpause")}
          size="icon-xs"
          variant="ghost"
        >
          <Play />
        </IconButton>
      ) : (
        <IconButton label="Pause" onClick={() => run("pause")} size="icon-xs" variant="ghost">
          <Pause />
        </IconButton>
      )}
      <IconButton
        className="text-destructive"
        label="Stop"
        onClick={() => run("stop")}
        size="icon-xs"
        variant="ghost"
      >
        <Square />
      </IconButton>
      <IconButton
        disabled={session.leases.length === 0}
        label="Focus app"
        onClick={() => run("focusSession")}
        size="icon-xs"
        variant="ghost"
      >
        <ArrowUpRight />
      </IconButton>
      <IconButton label="Minimize" onClick={minimizeComputerPip} size="icon-xs" variant="ghost">
        <Minus />
      </IconButton>
    </div>
  );
}

/** The live frame, with the agent cursor drawn where it is. */
function PipFrame({
  cursor,
  frame,
}: {
  cursor: ComputerCursor | undefined;
  frame: ComputerScreenshot;
}) {
  const box = useElementSize<HTMLDivElement>();
  const position = cursor ? cursorInFrame(cursor, frame) : null;
  // `object-contain` letterboxes the image, so the cursor is placed within
  // the image's fitted bounds, not the whole panel.
  const fitted = box.size ? containedRect(frame, box.size) : null;
  return (
    <div className="relative h-full w-full">
      <div className="absolute inset-0" ref={box.ref}>
        <img
          alt="What the agent sees"
          className="h-full w-full object-contain"
          src={`data:image/${frame.format};base64,${frame.base64 ?? ""}`}
        />
        {position && fitted ? (
          <MousePointer2
            className="absolute size-4 fill-primary text-primary-foreground drop-shadow"
            style={{
              left: fitted.left + (position.left / 100) * fitted.width,
              top: fitted.top + (position.top / 100) * fitted.height,
            }}
          />
        ) : null}
      </div>
    </div>
  );
}

type Size = { width: number; height: number };

/** The element's content size, kept current as it resizes. */
function useElementSize<T extends HTMLElement>(): {
  ref: (element: T | null) => void;
  size: Size | null;
} {
  const [element, ref] = useState<T | null>(null);
  const [size, setSize] = useState<Size | null>(null);
  useEffect(() => {
    if (!element) return;
    const measure = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return { ref, size };
}

/** Where an `object-contain` image of `image`'s size is drawn inside `box`, in pixels. */
export function containedRect(
  image: Size,
  box: Size,
): (Size & { left: number; top: number }) | null {
  if (image.width <= 0 || image.height <= 0 || box.width <= 0 || box.height <= 0) return null;
  const scale = Math.min(box.width / image.width, box.height / image.height);
  const width = image.width * scale;
  const height = image.height * scale;
  return { left: (box.width - width) / 2, top: (box.height - height) / 2, width, height };
}

/** Stands in for the frame: why there is none yet, and the fix when it is a grant. */
function PipPlaceholder({ failure }: { failure: FrameFailure | null }) {
  if (failure?.screenRecordingOff) {
    return (
      <div
        className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center text-xs"
        data-testid="computer-pip-screen-recording"
      >
        <span className="text-muted-foreground">
          The preview needs Screen Recording for Pragma Computer Use.
        </span>
        <Button onClick={requestScreenRecording} size="sm" variant="outline">
          Allow Screen Recording
        </Button>
      </div>
    );
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center text-xs text-muted-foreground">
      <span>Waiting for the first frame…</span>
      {failure ? <span className="line-clamp-2 opacity-70">{failure.message}</span> : null}
    </div>
  );
}

/** Shows the macOS prompt, or the System Settings pane once it was answered. */
function requestScreenRecording() {
  void computerRpc({ op: "permissions", request: true, permission: "screenRecording" }).catch(
    (error: unknown) => toast.error(errorMessage(error)),
  );
}

/** Why the latest capture produced no frame. */
type FrameFailure = { message: string; screenRecordingOff: boolean };

/** Where a screen-space cursor falls in a frame, as percentages of its size. */
export function cursorInFrame(
  cursor: Pick<ComputerCursor, "point">,
  frame: Pick<ComputerScreenshot, "origin" | "scale" | "width" | "height">,
): { left: number; top: number } | null {
  if (frame.width <= 0 || frame.height <= 0) return null;
  const left = (((cursor.point.x - frame.origin.x) * frame.scale) / frame.width) * 100;
  const top = (((cursor.point.y - frame.origin.y) * frame.scale) / frame.height) * 100;
  if (left < 0 || top < 0 || left > 100 || top > 100) return null;
  return { left, top };
}

/**
 * Streams the session's frame while the window is visible, and why it has
 * none when a capture fails. Recheck grants during failures so a stale or
 * unavailable permission result cannot hide the recovery button indefinitely.
 */
function useFrame(sessionId: string | null, maxWidth: number) {
  const [frame, setFrame] = useState<ComputerScreenshot | null>(null);
  const [failureMessage, setFailureMessage] = useState<string | null>(null);
  const [visible, setVisible] = useState(document.visibilityState !== "hidden");
  const { permissions } = useComputerPermissions({
    enabled: sessionId !== null && visible && failureMessage !== null,
    pollWhileGranted: true,
  });
  const failure: FrameFailure | null =
    failureMessage === null
      ? null
      : {
          message: failureMessage,
          screenRecordingOff:
            (/screen[\s_-]*(?:recording|capture)/i.test(failureMessage) &&
              /permission|access|denied|not (?:allowed|available)|grant/i.test(failureMessage)) ||
            (permissions?.platform === "macos" && permissions.screenRecording !== "granted"),
        };
  useEffect(() => {
    const changed = () => setVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => {
    setFrame(null);
    setFailureMessage(null);
    if (!sessionId || !visible) return;
    let cancelled = false;
    let release: (() => void) | undefined;
    const failed = (message: string) => {
      if (cancelled) return;
      setFrame(null);
      setFailureMessage(message);
    };
    void streamComputerFrames(
      sessionId,
      maxWidth,
      (next) => {
        if (cancelled) return;
        setFailureMessage(null);
        setFrame(next);
      },
      failed,
    )
      .then((stop) => {
        if (cancelled) stop();
        else release = stop;
        return undefined;
      })
      .catch((cause: unknown) => failed(errorMessage(cause)));
    return () => {
      cancelled = true;
      release?.();
    };
  }, [sessionId, maxWidth, visible]);
  return { frame, failure };
}

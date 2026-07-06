import { useEffect } from "react";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from "react-native-reanimated";

import type { AgentStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

interface AgentStatusDotProps {
  status: AgentStatus | null;
  className?: string;
}

// Colour per status mirrors the desktop AgentStatusDot: running = warning,
// attention = destructive (pulsing), done = success. `cleared`/null render
// nothing so childless / idle rows stay clean.
const COLORS: Record<Exclude<AgentStatus, "cleared">, string> = {
  running: "bg-warning",
  attention: "bg-destructive",
  done: "bg-success",
};

/** Small aggregate status indicator for a worktree/project/agent row. */
export function AgentStatusDot({ status, className }: AgentStatusDotProps) {
  const pulse = useSharedValue(1);
  const attention = status === "attention";

  useEffect(() => {
    if (attention) {
      pulse.value = withRepeat(withTiming(0.3, { duration: 600 }), -1, true);
    } else {
      pulse.value = 1;
    }
  }, [attention, pulse]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: pulse.value }));

  if (!status || status === "cleared") {
    return null;
  }

  return (
    <Animated.View
      accessibilityLabel={`Agent ${status}`}
      className={cn("h-2.5 w-2.5 rounded-full", COLORS[status], className)}
      style={attention ? animatedStyle : undefined}
    />
  );
}

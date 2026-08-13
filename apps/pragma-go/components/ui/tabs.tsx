import * as TabsPrimitive from "@rn-primitives/tabs";
import {
  createContext,
  forwardRef,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import type { LayoutChangeEvent } from "react-native";
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from "react-native-reanimated";

import { cn } from "@/lib/utils";
import { TextClassContext } from "./text";

/** React Native Reusables Tabs, with a reanimated sliding indicator pill that
 *  follows the active trigger — the mobile twin of the desktop's `ui/tabs.tsx`
 *  sliding indicator. */
const Tabs = TabsPrimitive.Root;

interface TabFrame {
  x: number;
  width: number;
}

interface TabsIndicatorValue {
  activeValue: string | undefined;
  register: (value: string, frame: TabFrame) => void;
}

const TabsIndicatorContext = createContext<TabsIndicatorValue | null>(null);

const INDICATOR_MS = 200;

const TabsList = forwardRef<
  ElementRef<typeof TabsPrimitive.List>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, children, ...props }, ref) => {
  const { value } = TabsPrimitive.useRootContext();
  const [frames, setFrames] = useState<Record<string, TabFrame>>({});
  const translateX = useSharedValue(0);
  const width = useSharedValue(0);

  const register = useCallback((tabValue: string, frame: TabFrame) => {
    setFrames((previous) => {
      const current = previous[tabValue];
      if (current && current.x === frame.x && current.width === frame.width) return previous;
      return { ...previous, [tabValue]: frame };
    });
  }, []);

  const activeFrame = value ? frames[value] : undefined;

  useEffect(() => {
    if (!activeFrame) return;
    translateX.value = withTiming(activeFrame.x, { duration: INDICATOR_MS });
    width.value = withTiming(activeFrame.width, { duration: INDICATOR_MS });
  }, [activeFrame, translateX, width]);

  const indicatorStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: translateX.value }],
    width: width.value,
  }));

  const context = useMemo<TabsIndicatorValue>(
    () => ({ activeValue: value, register }),
    [value, register],
  );

  return (
    <TabsIndicatorContext.Provider value={context}>
      <TabsPrimitive.List
        ref={ref}
        className={cn("relative flex-row items-center rounded-lg bg-muted", className)}
        {...props}
      >
        <Animated.View
          className="absolute bottom-0 left-0 top-0 rounded-md bg-card"
          style={indicatorStyle}
        />
        {children}
      </TabsPrimitive.List>
    </TabsIndicatorContext.Provider>
  );
});
TabsList.displayName = TabsPrimitive.List.displayName;

const TabsTrigger = forwardRef<
  ElementRef<typeof TabsPrimitive.Trigger>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, children, onLayout, value, ...props }, ref) => {
  const context = useContext(TabsIndicatorContext);
  const active = context?.activeValue === value;

  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      onLayout?.(event);
      if (!context) return;
      const { x, width } = event.nativeEvent.layout;
      context.register(value, { x, width });
    },
    [context, onLayout, value],
  );

  const textClass = useMemo(
    () => cn("text-sm font-medium text-muted-foreground", active && "text-foreground"),
    [active],
  );

  return (
    <TextClassContext.Provider value={textClass}>
      <TabsPrimitive.Trigger
        ref={ref}
        className={cn(
          "flex-1 items-center justify-center rounded-md px-3 py-2",
          props.disabled && "opacity-50",
          className,
        )}
        onLayout={handleLayout}
        value={value}
        {...props}
      >
        {children}
      </TabsPrimitive.Trigger>
    </TextClassContext.Provider>
  );
});
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName;

const TabsContent = forwardRef<
  ElementRef<typeof TabsPrimitive.Content>,
  ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content ref={ref} className={cn("mt-2", className)} {...props} />
));
TabsContent.displayName = TabsPrimitive.Content.displayName;

export { Tabs, TabsContent, TabsList, TabsTrigger };

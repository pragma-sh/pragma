import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { motion } from "motion/react";
import { Tabs as TabsPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
import { motionTransition } from "@/lib/motion";

/**
 * Mirrors the Radix root's value so triggers know, in JS, whether they're the
 * active one — the sliding indicator is a real element that moves between
 * triggers via a shared `layoutId`, which CSS `data-active:` styling can't do.
 * `layoutIdPrefix` scopes that shared id per `Tabs` instance so two tab strips
 * on screen never trade indicators with each other.
 */
interface TabsContextValue {
  value: string | undefined;
  layoutIdPrefix: string;
}

const TabsContext = React.createContext<TabsContextValue | null>(null);

function Tabs({
  className,
  orientation = "horizontal",
  value,
  defaultValue,
  onValueChange,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>) {
  const layoutIdPrefix = React.useId();
  const [uncontrolledValue, setUncontrolledValue] = React.useState(defaultValue);
  const activeValue = value ?? uncontrolledValue;
  const handleValueChange = React.useCallback(
    (next: string) => {
      setUncontrolledValue(next);
      onValueChange?.(next);
    },
    [onValueChange],
  );
  const context = React.useMemo<TabsContextValue>(
    () => ({ value: activeValue, layoutIdPrefix }),
    [activeValue, layoutIdPrefix],
  );

  return (
    <TabsContext.Provider value={context}>
      <TabsPrimitive.Root
        data-slot="tabs"
        data-orientation={orientation}
        className={cn("group/tabs flex gap-2 data-horizontal:flex-col", className)}
        onValueChange={handleValueChange}
        value={activeValue}
        {...props}
      />
    </TabsContext.Provider>
  );
}

const tabsListVariants = cva(
  "group/tabs-list inline-flex w-fit items-center justify-center rounded-lg p-[3px] text-muted-foreground group-data-horizontal/tabs:h-8 group-data-vertical/tabs:h-fit group-data-vertical/tabs:flex-col data-[variant=line]:rounded-none",
  {
    variants: {
      variant: {
        // `overflow-hidden` keeps the sliding pill inside the strip. The
        // indicator is a shared-layout element measured in viewport
        // coordinates, so a resizing ancestor (e.g. `ModalShell`'s
        // `layout="size"` card growing as a dialog swaps modes) skews its
        // projection mid-flight and it would otherwise sweep past the list.
        default: "overflow-hidden bg-muted",
        // Not clipped: the underline deliberately sits outside the list box.
        line: "gap-1 bg-transparent",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

const TabsListVariantContext = React.createContext<"default" | "line">("default");

function TabsList({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List> & VariantProps<typeof tabsListVariants>) {
  return (
    <TabsListVariantContext.Provider value={variant ?? "default"}>
      <TabsPrimitive.List
        data-slot="tabs-list"
        data-variant={variant}
        className={cn(tabsListVariants({ variant }), className)}
        {...props}
      />
    </TabsListVariantContext.Provider>
  );
}

/**
 * The moving pill (or underline, in the `line` variant) that follows the active
 * trigger. Rendered only inside the active trigger; Motion's shared-layout
 * animation slides it from wherever it previously sat.
 */
function TabsIndicator({ layoutId }: { layoutId: string }) {
  const variant = React.useContext(TabsListVariantContext);
  return (
    <motion.span
      aria-hidden
      className={cn(
        "absolute",
        variant === "line"
          ? "group-data-horizontal/tabs:inset-x-0 group-data-horizontal/tabs:bottom-[-5px] group-data-horizontal/tabs:h-0.5 group-data-vertical/tabs:inset-y-0 group-data-vertical/tabs:-right-1 group-data-vertical/tabs:w-0.5 bg-foreground"
          : "inset-0 rounded-md border border-transparent bg-background shadow-sm dark:border-input dark:bg-input/30",
      )}
      layoutId={layoutId}
      transition={motionTransition.indicator}
    />
  );
}

function TabsTrigger({
  className,
  children,
  value,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>) {
  const context = React.useContext(TabsContext);
  const active = context?.value === value;
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      value={value}
      className={cn(
        // The active fill/underline moved to `TabsIndicator` so it can slide;
        // what stays here is everything that doesn't travel between triggers.
        "relative inline-flex h-[calc(100%-1px)] flex-1 items-center justify-center gap-1.5 rounded-md border border-transparent px-1.5 py-0.5 text-sm font-medium whitespace-nowrap text-foreground/60 transition-colors group-data-vertical/tabs:w-full group-data-vertical/tabs:justify-start hover:text-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-1 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 has-data-[icon=inline-end]:pr-1 has-data-[icon=inline-start]:pl-1 dark:text-muted-foreground dark:hover:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        "data-active:text-foreground dark:data-active:text-foreground",
        className,
      )}
      {...props}
    >
      {active && context ? <TabsIndicator layoutId={`${context.layoutIdPrefix}-tab`} /> : null}
      {/* Above the indicator: it is absolutely positioned and comes first in DOM order. */}
      <span className="relative inline-flex items-center gap-1.5">{children}</span>
    </TabsPrimitive.Trigger>
  );
}

function TabsContent({ className, ...props }: React.ComponentProps<typeof TabsPrimitive.Content>) {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn("flex-1 text-sm outline-none", className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent, tabsListVariants };

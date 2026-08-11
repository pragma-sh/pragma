import * as React from "react";
import { motion } from "motion/react";
import { Collapsible as CollapsiblePrimitive } from "radix-ui";

import { useDisclosureVariants } from "@/lib/motion";

/**
 * Mirrors the Radix root's open state. Radix drives disclosure through mount /
 * `hidden`, which gives the content no frames to grow or shrink in — so the
 * content is force-mounted and its height is animated here instead.
 */
const CollapsibleOpenContext = React.createContext(false);

function Collapsible({
  open,
  defaultOpen,
  onOpenChange,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false);
  const isOpen = open ?? uncontrolledOpen;
  const handleOpenChange = React.useCallback(
    (next: boolean) => {
      setUncontrolledOpen(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  return (
    <CollapsibleOpenContext.Provider value={isOpen}>
      <CollapsiblePrimitive.Root
        data-slot="collapsible"
        open={isOpen}
        onOpenChange={handleOpenChange}
        {...props}
      />
    </CollapsibleOpenContext.Provider>
  );
}

function CollapsibleTrigger({
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleTrigger>) {
  return <CollapsiblePrimitive.CollapsibleTrigger data-slot="collapsible-trigger" {...props} />;
}

function CollapsibleContent({
  className,
  children,
  ...props
}: React.ComponentProps<typeof CollapsiblePrimitive.CollapsibleContent>) {
  const open = React.useContext(CollapsibleOpenContext);
  const variants = useDisclosureVariants();
  return (
    <CollapsiblePrimitive.CollapsibleContent
      data-slot="collapsible-content"
      forceMount
      asChild
      {...props}
    >
      {/* The animated box owns only `height` + `overflow: hidden`; the caller's
          classes (padding, spacing) go on the inner element, or the padding
          would keep the collapsed box taller than zero. */}
      <motion.div
        animate={open ? "expanded" : "collapsed"}
        className="overflow-hidden"
        initial={false}
        variants={variants}
      >
        <div className={className}>{children}</div>
      </motion.div>
    </CollapsiblePrimitive.CollapsibleContent>
  );
}

export { Collapsible, CollapsibleTrigger, CollapsibleContent };

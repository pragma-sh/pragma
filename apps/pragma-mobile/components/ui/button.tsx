import { cva, type VariantProps } from "class-variance-authority";
import { Pressable, type PressableProps } from "react-native";

import { hapticSelection } from "@/lib/haptics";
import { cn } from "@/lib/utils";
import { TextClassContext } from "./text";

const buttonVariants = cva(
  "flex-row items-center justify-center gap-2 rounded-lg active:opacity-80",
  {
    variants: {
      variant: {
        default: "bg-primary",
        destructive: "bg-destructive",
        success: "bg-success",
        secondary: "bg-secondary",
        outline: "border border-border bg-transparent",
        ghost: "bg-transparent",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-3",
        lg: "h-12 px-6",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: { variant: "default", size: "default" },
  },
);

const buttonTextVariants = cva("text-base font-medium", {
  variants: {
    variant: {
      default: "text-primary-foreground",
      destructive: "text-destructive-foreground",
      success: "text-success-foreground",
      secondary: "text-secondary-foreground",
      outline: "text-foreground",
      ghost: "text-foreground",
    },
    size: { default: "", sm: "text-sm", lg: "text-lg", icon: "" },
  },
  defaultVariants: { variant: "default", size: "default" },
});

export interface ButtonProps extends PressableProps, VariantProps<typeof buttonVariants> {
  className?: string;
  /** Fire selection haptics on press (default true). */
  haptics?: boolean;
}

/** Themed pressable button with built-in selection haptics. */
export function Button({
  className,
  variant,
  size,
  haptics = true,
  onPress,
  ...props
}: ButtonProps) {
  return (
    <TextClassContext.Provider value={buttonTextVariants({ variant, size })}>
      <Pressable
        accessibilityRole="button"
        className={cn(buttonVariants({ variant, size }), className)}
        onPress={(event) => {
          if (haptics) hapticSelection();
          onPress?.(event);
        }}
        {...props}
      />
    </TextClassContext.Provider>
  );
}

export { buttonTextVariants, buttonVariants };

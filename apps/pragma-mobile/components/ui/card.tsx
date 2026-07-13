import { type ComponentProps } from "react";
import { View, type ViewProps } from "react-native";

import { cn } from "@/lib/utils";
import { Text } from "./text";

/** Rounded, bordered surface used for grouped content and inbox cards. */
export function Card({ className, ...props }: ViewProps & { className?: string }) {
  return (
    <View
      className={cn("overflow-hidden rounded-2xl border border-border bg-card", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn("gap-1 p-4", className)} {...props} />;
}

export function CardContent({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn("p-4 pt-0", className)} {...props} />;
}

export function CardFooter({ className, ...props }: ViewProps & { className?: string }) {
  return <View className={cn("flex-row items-center p-4 pt-0", className)} {...props} />;
}

export function CardTitle({ className, ...props }: ComponentProps<typeof Text>) {
  return (
    <Text className={cn("text-lg font-semibold text-card-foreground", className)} {...props} />
  );
}

export function CardDescription({ className, ...props }: ComponentProps<typeof Text>) {
  return <Text className={cn("text-sm text-muted-foreground", className)} {...props} />;
}

import { createContext, useContext } from "react";
import { Text as RNText, type TextProps as RNTextProps } from "react-native";

import { cn } from "@/lib/utils";

/** Lets a parent (e.g. Button) push default text classes onto nested <Text>. */
export const TextClassContext = createContext<string | undefined>(undefined);

export interface TextProps extends RNTextProps {
  className?: string;
}

/** Themed text primitive (React Native Reusables convention). */
export function Text({ className, ...props }: TextProps) {
  const context = useContext(TextClassContext);
  return <RNText className={cn("text-base text-foreground", context, className)} {...props} />;
}

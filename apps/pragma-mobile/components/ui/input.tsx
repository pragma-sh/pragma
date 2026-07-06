import { TextInput, type TextInputProps } from "react-native";

import { cn } from "@/lib/utils";

export interface InputProps extends TextInputProps {
  className?: string;
}

/** Themed single-line text input. */
export function Input({ className, placeholderTextColor, ...props }: InputProps) {
  return (
    <TextInput
      className={cn(
        "h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground",
        className,
      )}
      placeholderTextColor={placeholderTextColor ?? "hsl(240 4% 46%)"}
      {...props}
    />
  );
}

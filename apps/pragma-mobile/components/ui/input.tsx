import { TextInput, type TextInputProps } from "react-native";

import { cn } from "@/lib/utils";
import { useThemeColors } from "@/lib/theme";

export interface InputProps extends TextInputProps {
  className?: string;
}

/** Themed single-line text input. */
export function Input({ className, placeholderTextColor, ...props }: InputProps) {
  const colors = useThemeColors();
  return (
    <TextInput
      className={cn(
        "h-11 rounded-lg border border-input bg-background px-3 text-base text-foreground",
        className,
      )}
      placeholderTextColor={placeholderTextColor ?? colors.mutedForeground}
      {...props}
    />
  );
}

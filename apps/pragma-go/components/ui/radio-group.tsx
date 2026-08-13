import * as RadioGroupPrimitive from "@rn-primitives/radio-group";
import { View } from "react-native";

import { cn } from "@/lib/utils";

/** Radio group root — React Native Reusables wrapper over @rn-primitives. */
export function RadioGroup({ className, ...props }: RadioGroupPrimitive.RootProps) {
  return <RadioGroupPrimitive.Root className={cn("gap-3", className)} {...props} />;
}

/** A single selectable radio, showing a filled dot when active. */
export function RadioGroupItem({ className, ...props }: RadioGroupPrimitive.ItemProps) {
  return (
    <RadioGroupPrimitive.Item
      className={cn(
        "h-6 w-6 items-center justify-center rounded-full border-2 border-primary",
        props.disabled && "opacity-50",
        className,
      )}
      {...props}
    >
      <RadioGroupPrimitive.Indicator className="items-center justify-center">
        <View className="h-3 w-3 rounded-full bg-primary" />
      </RadioGroupPrimitive.Indicator>
    </RadioGroupPrimitive.Item>
  );
}

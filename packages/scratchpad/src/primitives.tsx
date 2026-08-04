import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ProgressHTMLAttributes,
  TextareaHTMLAttributes,
} from "react";

import { ensureScratchpadStyles } from "./styles";

/** Visual weight of a scratchpad {@link Button}. */
export type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "danger";

/** Semantic color of a {@link Badge} or {@link Progress}. */
export type Tone = "neutral" | "primary" | "success" | "warning" | "danger";

const TONE_VARIABLE: Record<Tone, string> = {
  neutral: "var(--muted-foreground)",
  primary: "var(--primary)",
  success: "var(--success)",
  warning: "var(--warning)",
  danger: "var(--destructive)",
};

function classNames(...values: readonly (string | false | undefined)[]): string {
  return values.filter(Boolean).join(" ");
}

/** Props for {@link Button}. */
export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: "sm" | "md";
}

/** Scratchpad button matching desktop shadcn button proportions and tokens. */
export function Button({
  className,
  size = "md",
  type = "button",
  variant = "secondary",
  ...rest
}: ButtonProps): React.JSX.Element {
  ensureScratchpadStyles();
  return (
    <button
      {...rest}
      className={classNames(
        "pragma-button",
        `pragma-button--${variant}`,
        size === "sm" && "pragma-button--sm",
        className,
      )}
      type={type}
    />
  );
}

/** Scratchpad single-line input matching desktop shadcn input tokens. */
export function Input({
  className,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>): React.JSX.Element {
  ensureScratchpadStyles();
  return <input {...rest} className={classNames("pragma-input", className)} />;
}

/** Scratchpad multiline input matching desktop shadcn textarea tokens. */
export function Textarea({
  className,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>): React.JSX.Element {
  ensureScratchpadStyles();
  return <textarea {...rest} className={classNames("pragma-textarea", className)} />;
}

/** Props for {@link Progress}. */
export interface ProgressProps extends ProgressHTMLAttributes<HTMLProgressElement> {
  tone?: Tone;
}

/** Scratchpad progress bar using desktop semantic colors. */
export function Progress({
  className,
  style,
  tone = "primary",
  ...rest
}: ProgressProps): React.JSX.Element {
  ensureScratchpadStyles();
  return (
    <progress
      {...rest}
      className={classNames("pragma-progress", className)}
      style={{ ["--pragma-tone" as string]: TONE_VARIABLE[tone], ...style }}
    />
  );
}

/** Surface that frames one scratchpad component, matching desktop cards. */
export function Card({ className, ...rest }: HTMLAttributes<HTMLElement>): React.JSX.Element {
  ensureScratchpadStyles();
  return <section {...rest} className={classNames("pragma-card", className)} />;
}

/** Props for {@link Badge}. */
export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  tone?: Tone;
}

/** Small state pill; color communicates state, never decoration. */
export function Badge({ className, tone = "neutral", ...rest }: BadgeProps): React.JSX.Element {
  ensureScratchpadStyles();
  return (
    <span
      {...rest}
      className={classNames(
        "pragma-badge",
        tone !== "neutral" && `pragma-badge--${tone}`,
        className,
      )}
    />
  );
}

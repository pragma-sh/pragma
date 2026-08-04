/**
 * Stylesheet shared by the scratchpad primitives and composed UI components.
 *
 * Scratchpads render inside a sandboxed iframe with no Tailwind runtime, so the
 * look is expressed as plain CSS keyed entirely on the desktop theme variables
 * (`--card`, `--primary`, `--radius-md`, ...). The host injects the desktop's
 * resolved token values into the frame, so every component follows the active
 * Pragma theme — including `.pragma/theme.json` overrides. The literal fallback
 * after each `var()` only applies when a scratchpad is rendered outside Pragma.
 */

/** Element id of the injected component stylesheet. */
const SCRATCHPAD_STYLE_ELEMENT_ID = "pragma-scratchpad-styles";

/** CSS for every `pragma-*` class used by the scratchpad components. */
const SCRATCHPAD_STYLES = `
.pragma-card {
  display: grid;
  gap: 0.75rem;
  margin: 1rem 0;
  padding: 0.875rem 1rem;
  border: 1px solid var(--border, #3f3f46);
  border-radius: var(--radius-lg, 10px);
  background: var(--card, #18181b);
  color: var(--card-foreground, #fafafa);
  box-shadow: var(--shadow-raised, 0 1px 2px rgb(0 0 0 / 0.3));
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 0.8125rem;
  line-height: 1.55;
}
.pragma-card > :first-child { margin-top: 0; }
.pragma-card > :last-child { margin-bottom: 0; }

.pragma-eyebrow {
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground, #a1a1aa);
}
.pragma-title {
  font-size: 0.9375rem;
  font-weight: 600;
  line-height: 1.4;
  color: var(--card-foreground, #fafafa);
}
.pragma-hint { font-size: 0.75rem; color: var(--muted-foreground, #a1a1aa); }
.pragma-stack { display: grid; gap: 0.5rem; }
.pragma-row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.pragma-row--between { justify-content: space-between; }
.pragma-row--end { justify-content: flex-end; }
.pragma-empty {
  padding: 0.75rem;
  border: 1px dashed var(--border, #3f3f46);
  border-radius: var(--radius-md, 8px);
  font-size: 0.75rem;
  color: var(--muted-foreground, #a1a1aa);
  text-align: center;
}
.pragma-chip {
  padding: 0.0625rem 0.375rem;
  border-radius: var(--radius-sm, 6px);
  background: var(--muted, #27272a);
  color: var(--muted-foreground, #a1a1aa);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.6875rem;
}

.pragma-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.375rem;
  min-height: 2rem;
  padding: 0 0.75rem;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  font-family: inherit;
  font-size: 0.8125rem;
  font-weight: 500;
  line-height: 1;
  cursor: pointer;
  white-space: nowrap;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}
.pragma-button:focus-visible { outline: 2px solid var(--ring, #22d3ee); outline-offset: 2px; }
.pragma-button:disabled { cursor: not-allowed; opacity: 0.5; }
.pragma-button--sm { min-height: 1.75rem; padding: 0 0.5rem; font-size: 0.75rem; }
.pragma-button--primary {
  background: var(--primary, #2563eb);
  color: var(--primary-foreground, #fafafa);
}
.pragma-button--primary:hover:not(:disabled) { background: var(--primary-hover, #1d4ed8); }
.pragma-button--secondary {
  background: var(--secondary, #27272a);
  color: var(--secondary-foreground, #fafafa);
}
.pragma-button--secondary:hover:not(:disabled) { background: var(--accent, #3f3f46); }
.pragma-button--outline {
  border-color: var(--input, #3f3f46);
  background: transparent;
  color: var(--foreground, #fafafa);
}
.pragma-button--outline:hover:not(:disabled) {
  background: var(--accent, #27272a);
  color: var(--accent-foreground, #fafafa);
}
.pragma-button--ghost { background: transparent; color: var(--muted-foreground, #a1a1aa); }
.pragma-button--ghost:hover:not(:disabled) {
  background: var(--accent, #27272a);
  color: var(--accent-foreground, #fafafa);
}
.pragma-button--danger {
  background: var(--destructive, #ef4444);
  color: var(--destructive-foreground, #fafafa);
}
.pragma-button--danger:hover:not(:disabled) { filter: brightness(1.08); }

.pragma-input,
.pragma-textarea {
  width: 100%;
  padding: 0.4375rem 0.625rem;
  border: 1px solid var(--input, #3f3f46);
  border-radius: var(--radius-md, 8px);
  background: var(--background, #09090b);
  color: var(--foreground, #fafafa);
  font-family: inherit;
  font-size: 0.8125rem;
  line-height: 1.5;
  transition: border-color 0.12s ease;
}
.pragma-input::placeholder,
.pragma-textarea::placeholder { color: var(--muted-foreground, #71717a); }
.pragma-input:focus-visible,
.pragma-textarea:focus-visible {
  border-color: var(--ring, #22d3ee);
  outline: 2px solid var(--ring, #22d3ee);
  outline-offset: -1px;
}
.pragma-input:disabled,
.pragma-textarea:disabled { cursor: not-allowed; opacity: 0.5; }
.pragma-textarea { min-height: 5rem; resize: vertical; }

/*
 * Choice list shared by every AskQuestion shape: a circular radio for a single
 * answer, a square checkbox for multi-select. The native control is restyled
 * (\`appearance: none\`) rather than replaced, so keyboard roving, labels and
 * form semantics keep working inside the sandboxed frame.
 */
.pragma-choices { display: grid; gap: 0.25rem; }
.pragma-choice {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4375rem 0.5rem;
  border: 1px solid transparent;
  border-radius: var(--radius-md, 8px);
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.pragma-choice:hover { background: var(--accent, #27272a); }
.pragma-choice--checked {
  border-color: color-mix(in oklab, var(--primary, #2563eb) 45%, transparent);
  background: color-mix(in oklab, var(--primary, #2563eb) 10%, transparent);
}
.pragma-choice:has(:disabled) { cursor: not-allowed; opacity: 0.5; }
.pragma-choice:has(:disabled):hover { background: transparent; }
.pragma-choice__control {
  appearance: none;
  -webkit-appearance: none;
  display: grid;
  place-content: center;
  flex: none;
  width: 1rem;
  height: 1rem;
  margin: 0;
  border: 1px solid var(--input, #3f3f46);
  background: var(--background, #09090b);
  cursor: inherit;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}
.pragma-choice__control--radio { border-radius: 999px; }
.pragma-choice__control--check { border-radius: var(--radius-sm, 6px); }
.pragma-choice__control:focus-visible { outline: 2px solid var(--ring, #22d3ee); outline-offset: 2px; }
.pragma-choice__control:checked { border-color: var(--primary, #2563eb); }
.pragma-choice__control--radio:checked::after {
  content: "";
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 999px;
  background: var(--primary, #2563eb);
}
.pragma-choice__control--check:checked { background: var(--primary, #2563eb); }
.pragma-choice__control--check:checked::after {
  content: "";
  width: 0.3125rem;
  height: 0.5625rem;
  margin-top: -0.125rem;
  border: solid var(--primary-foreground, #fafafa);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.pragma-choice__label { flex: 1; min-width: 0; font-size: 0.8125rem; }
/* The "Other" row swaps its text for this field, so it has to sit on the row. */
.pragma-choice__other {
  padding: 0.125rem 0.375rem;
  font-size: 0.8125rem;
  cursor: text;
}

.pragma-progress {
  appearance: none;
  width: 100%;
  height: 0.375rem;
  border: 0;
  border-radius: 999px;
  overflow: hidden;
  background: var(--muted, #27272a);
  color: var(--pragma-tone, var(--primary, #22d3ee));
}
.pragma-progress::-webkit-progress-bar { background: var(--muted, #27272a); border-radius: 999px; }
.pragma-progress::-webkit-progress-value {
  background: var(--pragma-tone, var(--primary, #22d3ee));
  border-radius: 999px;
  transition: width 0.25s ease;
}
.pragma-progress::-moz-progress-bar {
  background: var(--pragma-tone, var(--primary, #22d3ee));
  border-radius: 999px;
}

.pragma-badge {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.0625rem 0.4375rem;
  border: 1px solid currentColor;
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground, #a1a1aa);
  font-size: 0.6875rem;
  font-weight: 500;
  line-height: 1.5;
}
.pragma-badge--primary { color: var(--primary, #22d3ee); }
.pragma-badge--success { color: var(--success, #22c55e); }
.pragma-badge--warning { color: var(--warning, #eab308); }
.pragma-badge--danger { color: var(--destructive, #ef4444); }

/*
 * Side-by-side diff modelled on the desktop's \`@codemirror/merge\` view: one
 * scroll container so both panes stay row-aligned, a line-number gutter per
 * pane, whole-line tinting for inserted/deleted lines and a stronger tint on
 * the words that actually changed (the equivalent of \`cm-changedText\`).
 */
.pragma-diff {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  max-height: 24rem;
  overflow-y: auto;
  border: 1px solid var(--border, #3f3f46);
  border-radius: var(--radius-md, 8px);
  background: var(--background, #09090b);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 0.75rem;
  line-height: 1.6;
  --pragma-diff-added: var(--diff-added, #22c55e);
  --pragma-diff-removed: var(--diff-removed, #ef4444);
}
@media (max-width: 34rem) { .pragma-diff { grid-template-columns: minmax(0, 1fr); } }
.pragma-diff__pane { min-width: 0; overflow-x: auto; }
.pragma-diff__pane--after { border-left: 1px solid var(--border, #3f3f46); }
@media (max-width: 34rem) {
  .pragma-diff__pane--after {
    border-left: 0;
    border-top: 1px solid var(--border, #3f3f46);
  }
}
.pragma-diff__label {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0.625rem;
  border-bottom: 1px solid var(--border, #3f3f46);
  background: var(--card, #18181b);
  font-family: var(--font-sans, system-ui, sans-serif);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
}
.pragma-diff__pane--before .pragma-diff__label { color: var(--pragma-diff-removed); }
.pragma-diff__pane--after .pragma-diff__label { color: var(--pragma-diff-added); }

.pragma-diff__lines { display: grid; padding: 0.25rem 0; min-width: max-content; }
.pragma-diff__line {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr);
  min-height: 1.6em;
  white-space: pre;
}
.pragma-diff__gutter {
  padding-right: 0.625rem;
  color: var(--muted-foreground, #71717a);
  opacity: 0.7;
  text-align: right;
  user-select: none;
}
.pragma-diff__text { padding-right: 0.75rem; font: inherit; }
.pragma-diff__line--removed {
  background: color-mix(in oklab, var(--pragma-diff-removed) 12%, transparent);
}
.pragma-diff__line--added {
  background: color-mix(in oklab, var(--pragma-diff-added) 12%, transparent);
}
.pragma-diff__pane--before .pragma-diff__line--changed {
  background: color-mix(in oklab, var(--pragma-diff-removed) 12%, transparent);
}
.pragma-diff__pane--after .pragma-diff__line--changed {
  background: color-mix(in oklab, var(--pragma-diff-added) 12%, transparent);
}
.pragma-diff__line--spacer { background: var(--muted, #27272a); opacity: 0.35; }
.pragma-diff__pane--before .pragma-diff__changed {
  background: color-mix(in oklab, var(--pragma-diff-removed) 30%, transparent);
}
.pragma-diff__pane--after .pragma-diff__changed {
  background: color-mix(in oklab, var(--pragma-diff-added) 30%, transparent);
}

.pragma-progress-row { display: grid; gap: 0.3125rem; }
.pragma-progress-row + .pragma-progress-row {
  padding-top: 0.625rem;
  border-top: 1px solid var(--border, #3f3f46);
}
.pragma-progress-row__name {
  min-width: 0;
  overflow: hidden;
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}
`;

/**
 * Injects {@link SCRATCHPAD_STYLES} into the current document once. Safe to call
 * on every render and in environments without a DOM.
 */
export function ensureScratchpadStyles(): void {
  if (typeof document === "undefined") return;
  if (document.getElementById(SCRATCHPAD_STYLE_ELEMENT_ID)) return;
  const element = document.createElement("style");
  element.id = SCRATCHPAD_STYLE_ELEMENT_ID;
  element.textContent = SCRATCHPAD_STYLES;
  document.head.append(element);
}

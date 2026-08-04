import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

import { alignDiffLines } from "./diff";
import type { DiffLine } from "./diff";
import { promptAgent, scratchpadBridge } from "./index";
import type { PromptAgentOptions, ScratchpadAgentProgress } from "./index";
import { OTHER_VALUE, composeAnswer, toggleChoice } from "./question";
import { Badge, Button, Card, Input, Progress, Textarea, type Tone } from "./primitives";

const EMPTY_OPTIONS: readonly AskQuestionOption[] = [];

/** A pending-aware send to the attached agent, shared by the interactive cards. */
interface AgentAction {
  pending: boolean;
  /** Resolves to whether the text reached an agent tab. */
  run: (text: string, onSent: () => void | Promise<void>) => Promise<boolean>;
}

function useAgentAction(options: PromptAgentOptions): AgentAction {
  const [pending, setPending] = useState(false);
  const run = async (text: string, onSent: () => void | Promise<void>): Promise<boolean> => {
    if (pending) return false;
    setPending(true);
    try {
      const delivered = await promptAgent(text, options);
      if (delivered) await onSent();
      return delivered;
    } finally {
      setPending(false);
    }
  };
  return { pending, run };
}

/** One labeled answer option for {@link AskQuestion}. */
export interface AskQuestionOption {
  label: string;
  value?: string;
}

/**
 * Shape of an {@link AskQuestion}: a single choice (`options`, `yes-no`), any
 * number of choices (`multi-select`), or free text only (`text`). Every choice
 * shape renders the same list — radios for a single answer, checkboxes for
 * `multi-select`.
 */
export type AskQuestionType = "options" | "yes-no" | "multi-select" | "text";

/** Props for {@link AskQuestion}. */
export interface AskQuestionProps extends PromptAgentOptions {
  question: string;
  type?: AskQuestionType;
  options?: readonly AskQuestionOption[];
  /** Appends an "Other" choice that reveals a free-text field when selected. */
  allowOpenResponse?: boolean;
  submitLabel?: string;
  onAnswer?: (answer: string) => void | Promise<void>;
}

/** Interactive question whose answer is sent to attached agent tab. */
export function AskQuestion({
  question,
  type = "options",
  options = EMPTY_OPTIONS,
  allowOpenResponse = false,
  submitLabel = "Send answer",
  onAnswer,
  onMissingAgent,
}: AskQuestionProps): React.JSX.Element {
  const [sent, setSent] = useState<string | null>(null);
  const { pending, run } = useAgentAction({ onMissingAgent });

  const submit = (value: string): Promise<boolean> =>
    run(`Answer to scratchpad question "${question}": ${value}`, async () => {
      await onAnswer?.(value);
      setSent(value);
    });

  return (
    <Card>
      <div className="pragma-row pragma-row--between">
        <span className="pragma-eyebrow">Question</span>
        {sent === null ? null : <Badge tone="success">Answered</Badge>}
      </div>
      <p className="pragma-title">{question}</p>
      {sent === null ? (
        <AskQuestionControls
          allowOpenResponse={allowOpenResponse}
          options={options}
          pending={pending}
          submit={submit}
          submitLabel={submitLabel}
          type={type}
        />
      ) : (
        <SettledNotice
          detail={`Answered “${sent}”.`}
          label="Answer again"
          onReset={() => setSent(null)}
        />
      )}
    </Card>
  );
}

interface AskQuestionControlsProps {
  allowOpenResponse: boolean;
  options: readonly AskQuestionOption[];
  pending: boolean;
  submit: (value: string) => Promise<boolean>;
  submitLabel: string;
  type: AskQuestionType;
}

/** Choice list or free-text form of an unanswered {@link AskQuestion}. */
function AskQuestionControls({
  allowOpenResponse,
  options,
  pending,
  submit,
  submitLabel,
  type,
}: AskQuestionControlsProps): React.JSX.Element {
  if (type === "text") {
    return <AskQuestionForm pending={pending} submit={submit} submitLabel={submitLabel} />;
  }
  return (
    <AskQuestionChoices
      allowOpenResponse={allowOpenResponse}
      choices={type === "yes-no" ? YES_NO_OPTIONS : options}
      multiple={type === "multi-select"}
      pending={pending}
      submit={submit}
      submitLabel={submitLabel}
    />
  );
}

const YES_NO_OPTIONS: readonly AskQuestionOption[] = [{ label: "Yes" }, { label: "No" }];

const OTHER_OPTION: AskQuestionOption = { label: "Other", value: OTHER_VALUE };

/** The value an option submits: its explicit `value`, else its label. */
function choiceValue(option: AskQuestionOption): string {
  return option.value ?? option.label;
}

interface AskQuestionChoicesProps {
  allowOpenResponse: boolean;
  choices: readonly AskQuestionOption[];
  multiple: boolean;
  pending: boolean;
  submit: (value: string) => Promise<boolean>;
  submitLabel: string;
}

/**
 * Radio (single answer) or checkbox (`multi-select`) choice list. Selecting the
 * optional "Other" choice reveals a free-text field whose contents replace that
 * choice in the submitted answer; multiple selections are joined with commas.
 */
function AskQuestionChoices({
  allowOpenResponse,
  choices,
  multiple,
  pending,
  submit,
  submitLabel,
}: AskQuestionChoicesProps): React.JSX.Element {
  const group = useId();
  const [selected, setSelected] = useState<readonly string[]>([]);
  const [other, setOther] = useState("");
  const items = allowOpenResponse ? [...choices, OTHER_OPTION] : choices;

  const toggle = (value: string): void =>
    setSelected((current) => toggleChoice(current, value, multiple));

  const answer = composeAnswer(selected, other);

  const send = (): void => {
    if (!answer) return;
    void submit(answer).then((delivered) => {
      if (delivered) {
        setSelected([]);
        setOther("");
      }
      return delivered;
    });
  };

  return (
    <form
      className="pragma-stack"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <div className="pragma-choices" role={multiple ? "group" : "radiogroup"}>
        {items.map((option) => {
          const value = choiceValue(option);
          const checked = selected.includes(value);
          return (
            <Choice
              checked={checked}
              disabled={pending}
              key={value}
              label={
                value === OTHER_VALUE && checked ? (
                  <Input
                    className="pragma-choice__other"
                    disabled={pending}
                    // The field sits inside the row's `<label>`; without this the
                    // click would bubble and re-toggle the choice it belongs to.
                    onClick={(event) => event.stopPropagation()}
                    onChange={(event) => setOther(event.target.value)}
                    placeholder="Answer in your own words"
                    value={other}
                  />
                ) : (
                  option.label
                )
              }
              multiple={multiple}
              name={group}
              onSelect={() => toggle(value)}
            />
          );
        })}
      </div>
      <div className="pragma-row pragma-row--end">
        <Button disabled={pending || !answer} type="submit" variant="primary">
          {pending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/**
 * One selectable row: a circular radio, or a square checkbox when `multiple`.
 * `label` is a node so the "Other" row can swap its text for an input in place.
 */
function Choice({
  checked,
  disabled,
  label,
  multiple,
  name,
  onSelect,
}: {
  checked: boolean;
  disabled: boolean;
  label: ReactNode;
  multiple: boolean;
  name: string;
  onSelect: () => void;
}): React.JSX.Element {
  const shape = multiple ? "check" : "radio";
  return (
    <label className={`pragma-choice${checked ? " pragma-choice--checked" : ""}`}>
      <input
        checked={checked}
        className={`pragma-choice__control pragma-choice__control--${shape}`}
        disabled={disabled}
        name={name}
        // A radio ignores a repeat click, so re-selecting the same choice after a
        // reset must still register: drive both shapes from `onChange` only.
        onChange={onSelect}
        type={multiple ? "checkbox" : "radio"}
      />
      <span className="pragma-choice__label">{label}</span>
    </label>
  );
}

/** Free-text answer field for a `text` {@link AskQuestion}. */
function AskQuestionForm({
  pending,
  submit,
  submitLabel,
}: {
  pending: boolean;
  submit: (value: string) => Promise<boolean>;
  submitLabel: string;
}): React.JSX.Element {
  const [answer, setAnswer] = useState("");
  const send = (): void => {
    const value = answer.trim();
    if (!value) return;
    void submit(value).then((delivered) => {
      if (delivered) setAnswer("");
      return delivered;
    });
  };
  return (
    <form
      className="pragma-stack"
      onSubmit={(event) => {
        event.preventDefault();
        send();
      }}
    >
      <Textarea
        disabled={pending}
        onChange={(event) => setAnswer(event.target.value)}
        placeholder="Type your answer"
        value={answer}
      />
      <div className="pragma-row pragma-row--end">
        <Button disabled={pending || !answer.trim()} type="submit" variant="primary">
          {pending ? "Sending…" : submitLabel}
        </Button>
      </div>
    </form>
  );
}

/** Props for {@link DiffReview}. */
export interface DiffReviewProps extends PromptAgentOptions {
  title?: string;
  before: string;
  after: string;
  file?: string;
  onDecision?: (accepted: boolean) => void | Promise<void>;
}

/** Before/after review card that returns accept/reject decision to attached agent. */
export function DiffReview({
  title = "Review change",
  before,
  after,
  file,
  onDecision,
  onMissingAgent,
}: DiffReviewProps): React.JSX.Element {
  const [decision, setDecision] = useState<boolean | null>(null);
  const { pending, run } = useAgentAction({ onMissingAgent });

  const decide = (accepted: boolean): Promise<boolean> =>
    run(`Scratchpad diff${file ? ` for ${file}` : ""} was ${verdict(accepted)}.`, async () => {
      await onDecision?.(accepted);
      setDecision(accepted);
    });

  return (
    <Card>
      <DiffHeader decision={decision} file={file} title={title} />
      <DiffPanes after={after} before={before} />
      {decision === null ? (
        <DiffActions decide={decide} pending={pending} />
      ) : (
        <SettledNotice
          detail={`Change ${verdict(decision)}.`}
          label="Decide again"
          onReset={() => setDecision(null)}
        />
      )}
    </Card>
  );
}

/** Title, reviewed file and settled verdict of a {@link DiffReview}. */
function DiffHeader({
  decision,
  file,
  title,
}: {
  decision: boolean | null;
  file?: string;
  title: string;
}): React.JSX.Element {
  return (
    <div className="pragma-row pragma-row--between">
      <div className="pragma-row">
        <span className="pragma-title">{title}</span>
        {file ? <code className="pragma-chip">{file}</code> : null}
      </div>
      {decision === null ? null : (
        <Badge tone={decision ? "success" : "danger"}>{verdictLabel(decision)}</Badge>
      )}
    </div>
  );
}

/** Accept/reject controls of an undecided {@link DiffReview}. */
function DiffActions({
  decide,
  pending,
}: {
  decide: (accepted: boolean) => Promise<boolean>;
  pending: boolean;
}): React.JSX.Element {
  return (
    <div className="pragma-row pragma-row--end">
      <Button disabled={pending} onClick={() => void decide(false)} variant="outline">
        Reject
      </Button>
      <Button disabled={pending} onClick={() => void decide(true)} variant="primary">
        Accept
      </Button>
    </div>
  );
}

function verdict(accepted: boolean): string {
  return accepted ? "accepted" : "rejected";
}

function verdictLabel(accepted: boolean): string {
  return accepted ? "Accepted" : "Rejected";
}

/**
 * Side-by-side comparison of a {@link DiffReview}, aligned row for row: equal
 * lines face each other, an unpaired insert/delete faces a spacer, and a
 * replaced line pair highlights only the words that actually changed.
 */
function DiffPanes({ after, before }: { after: string; before: string }): React.JSX.Element {
  const rows = useMemo(() => alignDiffLines(before, after), [before, after]);
  return (
    <div className="pragma-diff">
      <DiffPane label="Before" lines={rows.map((row) => row.before)} side="before" />
      <DiffPane label="After" lines={rows.map((row) => row.after)} side="after" />
    </div>
  );
}

/**
 * Renders a line's segments, tinting the ones that differ from the other side.
 * Keys are the segment's column offset, which is stable for a given line.
 */
function segmentNodes(line: DiffLine): React.JSX.Element[] {
  let column = 0;
  return line.segments.map((segment) => {
    const key = `${line.key}:${column}`;
    column += segment.text.length;
    return (
      <span className={segment.changed ? "pragma-diff__changed" : undefined} key={key}>
        {segment.text}
      </span>
    );
  });
}

/** One side of a {@link DiffReview} comparison, with gutter and line tinting. */
function DiffPane({
  label,
  lines,
  side,
}: {
  label: string;
  lines: DiffLine[];
  side: "before" | "after";
}): React.JSX.Element {
  return (
    <div className={`pragma-diff__pane pragma-diff__pane--${side}`}>
      <div className="pragma-diff__label">
        <span>{label}</span>
        <span>{side === "before" ? "−" : "+"}</span>
      </div>
      <div className="pragma-diff__lines">
        {lines.map((line) => (
          <div className={`pragma-diff__line pragma-diff__line--${line.kind}`} key={line.key}>
            <span aria-hidden={line.number === null} className="pragma-diff__gutter">
              {line.number ?? ""}
            </span>
            <code className="pragma-diff__text">{segmentNodes(line)}</code>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Footer shown once a card's answer or decision has reached the agent. */
function SettledNotice({
  detail,
  label,
  onReset,
}: {
  detail: string;
  label: string;
  onReset: () => void;
}): React.JSX.Element {
  return (
    <div className="pragma-row pragma-row--between">
      <span className="pragma-hint">{detail}</span>
      <Button onClick={onReset} size="sm" variant="ghost">
        {label}
      </Button>
    </div>
  );
}

/** Props for {@link AgentProgress}. */
export interface AgentProgressProps {
  tabIds: readonly string[];
  title?: string;
}

/** Live progress for any set of same-worktree agent tab IDs. */
export function AgentProgress({
  tabIds,
  title = "Agent progress",
}: AgentProgressProps): React.JSX.Element {
  const [entries, setEntries] = useState<readonly ScratchpadAgentProgress[]>([]);
  const key = tabIds.join(" ");
  const tabIdsRef = useRef(tabIds);
  tabIdsRef.current = tabIds;
  useEffect(() => scratchpadBridge().subscribeAgentProgress(tabIdsRef.current, setEntries), [key]);

  return (
    <Card>
      <div className="pragma-row pragma-row--between">
        <span className="pragma-title">{title}</span>
        <span className="pragma-hint">
          {entries.length} {entries.length === 1 ? "tab" : "tabs"}
        </span>
      </div>
      {entries.length === 0 ? (
        <p className="pragma-empty">No agent tabs are reporting yet.</p>
      ) : (
        <div className="pragma-stack">
          {entries.map((entry) => (
            <AgentProgressRow entry={entry} key={entry.tabId} />
          ))}
        </div>
      )}
    </Card>
  );
}

/** One agent tab's live status line inside {@link AgentProgress}. */
function AgentProgressRow({ entry }: { entry: ScratchpadAgentProgress }): React.JSX.Element {
  const meta = STATUS_META[entry.status];
  return (
    <div className="pragma-progress-row">
      <div className="pragma-row pragma-row--between">
        <span className="pragma-progress-row__name">
          {entry.title ?? entry.agent ?? entry.tabId}
        </span>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </div>
      <Progress max={100} tone={meta.tone} value={meta.value} />
    </div>
  );
}

interface StatusMeta {
  label: string;
  tone: Tone;
  value: number;
}

const STATUS_META: Record<ScratchpadAgentProgress["status"], StatusMeta> = {
  running: { label: "Running", tone: "primary", value: 40 },
  attention: { label: "Needs attention", tone: "warning", value: 70 },
  done: { label: "Done", tone: "success", value: 100 },
  cleared: { label: "Idle", tone: "neutral", value: 100 },
};

export {
  Badge,
  Button,
  Card,
  Input,
  Progress,
  Textarea,
  type BadgeProps,
  type ButtonProps,
  type ButtonVariant,
  type ProgressProps,
  type Tone,
} from "./primitives";

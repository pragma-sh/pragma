import type { AgentQuestion } from "@pragma-sh/sdk";

/**
 * Turns omp's `ask` tool form into Pragma questions, in the order its dialog
 * focuses them, using **omp's own** HTML form parser.
 *
 * `ask` takes one HTML `<form>` (radio groups, checkboxes, selects, text
 * inputs) and renders it as a native TUI dialog. The watcher answers that
 * dialog with keys, so the questions and options reported here must match the
 * dialog's focus stops exactly: enabled options only, in DOM order. Reusing
 * omp's parser (`@oh-my-pi/pi-tui/html-form/*`, which omp's extension loader
 * resolves to the copy bundled in the running binary) keeps that parity
 * instead of approximating it with a second parser.
 */

/** A text run of a parsed label. */
interface FormSpan {
  text: string;
}

/** The parts of omp's `ChoiceField` / `TextField` this mapping reads. */
interface OmpFormField {
  kind: "choice" | "text";
  name: string;
  multi?: boolean;
  select?: boolean;
  options?: Array<{ label: FormSpan[]; disabled: boolean }>;
}

/** The parts of omp's parsed `HtmlForm` this mapping reads. */
export interface OmpHtmlForm {
  fields: OmpFormField[];
}

/** omp's form modules, injectable for tests. */
export interface OmpFormModules {
  parseHtmlForm(html: string): OmpHtmlForm;
  fieldQuestions(form: OmpHtmlForm): Map<OmpFormField, string>;
}

/**
 * Loads omp's form parser from the host. Rejects outside omp.
 *
 * The specifiers must stay **string literals**: omp redirects `@oh-my-pi/*`
 * to its bundled copy by rewriting an extension's source, which only sees
 * literal specifiers (an `import(variable)` fails with "Cannot find package
 * '@oh-my-pi/pi-tui'" in a TUI session). The build keeps them external, and
 * `omp-modules.d.ts` types them.
 */
export async function loadOmpFormModules(): Promise<OmpFormModules> {
  const [parse, data] = await Promise.all([
    import("@oh-my-pi/pi-tui/html-form/parse"),
    import("@oh-my-pi/pi-tui/html-form/data"),
  ]);
  return {
    // The ambient declarations are deliberately loose; narrow to the shapes
    // this module reads.
    parseHtmlForm: parse.parseHtmlForm as OmpFormModules["parseHtmlForm"],
    fieldQuestions: data.fieldQuestions as OmpFormModules["fieldQuestions"],
  };
}

/**
 * The questions one `ask` form asks, one per named field.
 *
 * Radio and checkbox groups list their enabled options (the dialog's option
 * rows; its "Other" row stays a free-text answer). Dropdowns and text inputs
 * are reported without options: a dropdown is a single focus stop answered by
 * typing its label, so listing its options would make the watcher arrow past
 * it.
 */
export function askQuestions(html: string, modules: OmpFormModules): AgentQuestion[] {
  const form = modules.parseHtmlForm(html);
  const labels = modules.fieldQuestions(form);
  return form.fields.map((field) => {
    const question = labels.get(field) || field.name;
    // A single `<select>` is one dropdown stop (omp's `isDropdown`); a
    // multi-select renders option rows like a checkbox group.
    if (field.kind !== "choice" || (field.select && !field.multi)) return { question };
    const options = (field.options ?? [])
      .filter((option) => !option.disabled)
      .map((option) => ({ label: spanText(option.label) }))
      .filter((option) => option.label !== "");
    return options.length > 0 ? { question, options } : { question };
  });
}

function spanText(spans: FormSpan[]): string {
  return spans
    .map((span) => span.text)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

/** Shown when omp's form could not be parsed; the dialog itself is still on screen. */
const FALLBACK_QUESTION = "omp is asking a question";

/** The question fields of one `ask` attention report. */
export interface AskAttentionFields {
  question: string;
  options?: AgentQuestion["options"];
  questions?: AgentQuestion[];
}

/**
 * Shapes one form's questions into an attention report. `question` is always
 * a non-empty headline (clients show it, and `agent verify`'s stream check
 * requires it): the only field's question with its options, or the first
 * field's question plus the full `questions` batch for a multi-field form,
 * which the watcher answers field by field.
 */
export function askAttentionFields(questions: AgentQuestion[]): AskAttentionFields {
  const [first] = questions;
  const question = first?.question.trim() || FALLBACK_QUESTION;
  if (questions.length > 1) return { question, questions };
  return first?.options ? { question, options: first.options } : { question };
}

/**
 * Facts the support page states, kept in one place so the page, the footer, and
 * the App Store Connect listing cannot drift apart. App Review guideline 1.5
 * requires the submitted Support URL to carry current contact information, so
 * this module — not a component — owns the reply window and the routing.
 *
 * There is deliberately no support address. The form is the whole channel: a
 * published mailbox nobody reads is worse for a user than no mailbox at all,
 * and worse for App Review than a form that demonstrably works. If one is ever
 * stood up, add it here and nowhere else.
 */

/**
 * Route serving the support page. Submitted to App Store Connect verbatim as
 * the Support URL for Pragma Go, so changing it means updating the listing too.
 */
export const supportRoute = "/support";

/** Business days we commit to replying within. Shown on the page and honoured by the inbox. */
export const supportResponseDays = 2;

/** Products a request can be about. The value is what reaches the support inbox. */
export const supportProducts = [
  { value: "desktop", label: "Pragma for macOS, Linux, or Windows" },
  { value: "go", label: "Pragma Go for iPhone, iPad, or Android" },
  { value: "web", label: "Pragma Go in the browser" },
  { value: "site", label: "This website or the documentation" },
] as const;

/** Kinds of request, used to route the message and to set expectations on the page. */
export const supportTopics = [
  { value: "trouble", label: "Something is not working" },
  { value: "question", label: "A question about how something works" },
  { value: "account", label: "Purchases, licences, or account data" },
  { value: "accessibility", label: "An accessibility barrier" },
  { value: "feedback", label: "Feedback or a feature request" },
  { value: "security", label: "A security or privacy concern" },
] as const;

/**
 * Result of one submission attempt, rendered by the form through `useActionState`.
 *
 * It lives here rather than beside the action because a `"use server"` module
 * may only export async functions — Next strips everything else, and a stripped
 * initial state renders as `undefined` on the first paint.
 */
export type SupportFormState = {
  status: "idle" | "sent" | "error";
  /** Message shown in the form's live region. Empty while idle. */
  message: string;
  /** Per-field messages, keyed by the field's `name`, tied to its input by `aria-describedby`. */
  fieldErrors: Record<string, string>;
  /**
   * What was submitted, echoed back so an error does not clear the form.
   * React resets uncontrolled fields once a form action settles, so every
   * field re-seeds itself from here via `defaultValue`.
   */
  values: SupportRequestFields;
};

/** The state a freshly-mounted form starts from. */
export const supportFormInitialState: SupportFormState = {
  status: "idle",
  message: "",
  fieldErrors: {},
  values: { name: "", email: "", product: "", topic: "", version: "", message: "" },
};

/** splitforms caps a field value at 10 KB; we stop well short of it. */
const MESSAGE_MAX = 4000;
const MESSAGE_MIN = 20;
const SHORT_FIELD_MAX = 200;

/** The fields a support request carries, as read off the form. */
export type SupportRequestFields = {
  name: string;
  email: string;
  product: string;
  topic: string;
  version: string;
  message: string;
};

/** A validated request: the raw fields plus the human-readable labels we email. */
export type ValidatedSupportRequest = SupportRequestFields & {
  productLabel: string;
  topicLabel: string;
};

/**
 * Deliberately permissive: an address that looks like an address is accepted and
 * a bounce is the real check. Rejecting valid but unusual addresses would lock
 * someone out of the only support channel we publish.
 */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function labelFor(options: ReadonlyArray<{ value: string; label: string }>, value: string) {
  return options.find((option) => option.value === value)?.label;
}

/**
 * One field's rule. Returns the message to show, or `undefined` when the value
 * passes. Keeping each rule its own function is what lets the checks be read,
 * tested, and extended one at a time.
 */
type FieldRule = (fields: SupportRequestFields) => string | undefined;

function checkName({ name }: SupportRequestFields): string | undefined {
  if (!name) return "Tell us what to call you.";
  if (name.length > SHORT_FIELD_MAX) return `Please keep this under ${SHORT_FIELD_MAX} characters.`;
  return undefined;
}

function checkEmail({ email }: SupportRequestFields): string | undefined {
  if (!email) return "We need an address to reply to.";
  if (!looksLikeEmail(email)) return "That does not look like an email address.";
  return undefined;
}

function checkProduct({ product }: SupportRequestFields): string | undefined {
  return labelFor(supportProducts, product) ? undefined : "Choose which app this is about.";
}

function checkTopic({ topic }: SupportRequestFields): string | undefined {
  return labelFor(supportTopics, topic) ? undefined : "Choose what kind of request this is.";
}

function checkVersion({ version }: SupportRequestFields): string | undefined {
  return version.length > SHORT_FIELD_MAX
    ? `Please keep this under ${SHORT_FIELD_MAX} characters.`
    : undefined;
}

function checkMessage({ message }: SupportRequestFields): string | undefined {
  if (message.length < MESSAGE_MIN) {
    return `Please describe the problem in at least ${MESSAGE_MIN} characters.`;
  }
  if (message.length > MESSAGE_MAX) return `Please keep this under ${MESSAGE_MAX} characters.`;
  return undefined;
}

/** Every rule, keyed by the input `name` its message is rendered against. */
const fieldRules: Record<keyof SupportRequestFields, FieldRule> = {
  name: checkName,
  email: checkEmail,
  product: checkProduct,
  topic: checkTopic,
  version: checkVersion,
  message: checkMessage,
};

/** Run every rule and collect the messages that fired. */
function collectFieldErrors(fields: SupportRequestFields): Record<string, string> {
  const fieldErrors: Record<string, string> = {};
  for (const [field, rule] of Object.entries(fieldRules)) {
    const error = rule(fields);
    if (error) fieldErrors[field] = error;
  }
  return fieldErrors;
}

/**
 * Check one support request. Pure, so the rules are testable without a network
 * call and identical whether they run in the action or anywhere else later.
 *
 * Returns the request with its labels resolved, or the per-field messages the
 * form shows. Field keys match the inputs' `name` attributes.
 */
export function validateSupportRequest(
  fields: SupportRequestFields,
):
  | { ok: true; request: ValidatedSupportRequest }
  | { ok: false; fieldErrors: Record<string, string> } {
  const fieldErrors = collectFieldErrors(fields);
  const productLabel = labelFor(supportProducts, fields.product);
  const topicLabel = labelFor(supportTopics, fields.topic);

  if (!productLabel || !topicLabel || Object.keys(fieldErrors).length > 0) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, request: { ...fields, productLabel, topicLabel } };
}

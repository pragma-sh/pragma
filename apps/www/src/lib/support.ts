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
  const fieldErrors: Record<string, string> = {};

  if (!fields.name) fieldErrors.name = "Tell us what to call you.";
  else if (fields.name.length > SHORT_FIELD_MAX) {
    fieldErrors.name = `Please keep this under ${SHORT_FIELD_MAX} characters.`;
  }

  if (!fields.email) fieldErrors.email = "We need an address to reply to.";
  else if (!looksLikeEmail(fields.email)) {
    fieldErrors.email = "That does not look like an email address.";
  }

  const productLabel = labelFor(supportProducts, fields.product);
  if (!productLabel) fieldErrors.product = "Choose which app this is about.";

  const topicLabel = labelFor(supportTopics, fields.topic);
  if (!topicLabel) fieldErrors.topic = "Choose what kind of request this is.";

  if (fields.version.length > SHORT_FIELD_MAX) {
    fieldErrors.version = `Please keep this under ${SHORT_FIELD_MAX} characters.`;
  }

  if (fields.message.length < MESSAGE_MIN) {
    fieldErrors.message = `Please describe the problem in at least ${MESSAGE_MIN} characters.`;
  } else if (fields.message.length > MESSAGE_MAX) {
    fieldErrors.message = `Please keep this under ${MESSAGE_MAX} characters.`;
  }

  if (Object.keys(fieldErrors).length > 0 || !productLabel || !topicLabel) {
    return { ok: false, fieldErrors };
  }
  return { ok: true, request: { ...fields, productLabel, topicLabel } };
}

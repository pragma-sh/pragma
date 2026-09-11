"use server";

import { headers } from "next/headers";

import {
  type SupportFormState,
  type SupportRequestFields,
  supportResponseDays,
  type ValidatedSupportRequest,
  validateSupportRequest,
} from "@/lib/support";
import { isRateLimited } from "@/lib/support-rate-limit";

/** splitforms' single submission endpoint. It accepts JSON and answers with JSON. */
const SUBMIT_ENDPOINT = "https://splitforms.com/api/submit";

/**
 * The address to key the rate limiter by. First hop the platform reports, or
 * "unknown" if none is present (including when this runs outside a request,
 * such as a test) — the limiter still applies, just to one shared bucket.
 */
async function clientKey(): Promise<string> {
  try {
    const requestHeaders = await headers();
    const forwardedFor = requestHeaders.get("x-forwarded-for");
    if (forwardedFor) return forwardedFor.split(",")[0].trim();
    return requestHeaders.get("x-real-ip") ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

function readFields(data: FormData): SupportRequestFields {
  return {
    name: readField(data, "name"),
    email: readField(data, "email"),
    product: readField(data, "product"),
    topic: readField(data, "topic"),
    version: readField(data, "version"),
    message: readField(data, "message"),
  };
}

function sentState(message: string, values: SupportRequestFields): SupportFormState {
  return { status: "sent", message, fieldErrors: {}, values };
}

function errorState(
  message: string,
  values: SupportRequestFields,
  fieldErrors: Record<string, string> = {},
): SupportFormState {
  return { status: "error", message, fieldErrors, values };
}

/** The payload splitforms stores, plus the reserved fields that shape its email. */
function submissionBody(request: ValidatedSupportRequest, accessKey: string) {
  return {
    access_key: accessKey,
    // Reserved splitforms fields: they shape the notification email rather
    // than being stored as answers.
    subject: `Pragma support — ${request.topicLabel} (${request.productLabel})`,
    from_name: request.name,
    replyto: request.email,
    // Everything below is saved with the submission.
    name: request.name,
    email: request.email,
    product: request.productLabel,
    topic: request.topicLabel,
    version: request.version || "not given",
    message: request.message,
  };
}

const RATE_LIMIT_MESSAGE =
  "Too many requests from your connection just now. Wait a minute and send it again.";

/** Read one splitforms answer. Returns the message to show, or `undefined` when it landed. */
function responseFailure(response: Response): string | undefined {
  if (response.status === 429) {
    return RATE_LIMIT_MESSAGE;
  }
  if (!response.ok) {
    console.error(`splitforms rejected a support submission: HTTP ${response.status}`);
    return "We could not send that. Please try again in a moment; if it keeps failing, open an issue on GitHub.";
  }
  return undefined;
}

/**
 * POST one validated request to splitforms.
 *
 * Every failure path is a message rather than a throw, because the form's only
 * job on failure is to say what happened without losing what was typed.
 */
async function postSupportRequest(
  request: ValidatedSupportRequest,
  accessKey: string,
): Promise<string | undefined> {
  try {
    const response = await fetch(SUBMIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(submissionBody(request, accessKey)),
    });
    return responseFailure(response);
  } catch (error) {
    console.error("splitforms submission failed", error);
    return "We could not reach our support inbox. Please try again in a moment; if it keeps failing, open an issue on GitHub.";
  }
}

/**
 * Everything checked before we spend the form's quota: the per-connection rate
 * limit, the honeypot, then the field rules. Returns the state to answer with,
 * or the request to send.
 */
async function screenRequest(
  data: FormData,
  values: SupportRequestFields,
): Promise<{ state: SupportFormState } | { request: ValidatedSupportRequest }> {
  if (isRateLimited(await clientKey())) {
    return { state: errorState(RATE_LIMIT_MESSAGE, values) };
  }

  // Honeypot. A real person never sees this field, so anything in it is a bot.
  // Answer as though it worked: telling a bot it failed only teaches it.
  if (readField(data, "botcheck")) {
    return { state: sentState("Thanks — your request is on its way.", values) };
  }

  const result = validateSupportRequest(values);
  if (!result.ok) {
    return {
      state: errorState(
        "Some details need a second look before we can send this.",
        values,
        result.fieldErrors,
      ),
    };
  }
  return { request: result.request };
}

/**
 * Send one validated request to splitforms and describe the outcome.
 *
 * The access key stays on the server. It is not a secret — splitforms says as
 * much — but keeping it out of the bundle means the form cannot be replayed
 * from a scraped page.
 */
async function sendSupportRequest(
  request: ValidatedSupportRequest,
  values: SupportRequestFields,
): Promise<SupportFormState> {
  const accessKey = process.env.SPLIT_FORMS_ACCESS_KEY;
  if (!accessKey) {
    console.error("SPLIT_FORMS_ACCESS_KEY is not set; support form cannot submit.");
    return errorState(
      "The form is misconfigured on our side and cannot send right now. Please open an issue on GitHub so this reaches us.",
      values,
    );
  }

  const failure = await postSupportRequest(request, accessKey);
  if (failure) return errorState(failure, values);

  return sentState(
    `Thanks — your request is with us. We reply within ${supportResponseDays} business days, to ${request.email}.`,
    values,
  );
}

/** Entry point the form's `useActionState` calls on every submission attempt. */
export async function submitSupportRequest(
  _previous: SupportFormState,
  data: FormData,
): Promise<SupportFormState> {
  const values = readFields(data);
  const screened = await screenRequest(data, values);
  if ("state" in screened) return screened.state;
  return sendSupportRequest(screened.request, values);
}

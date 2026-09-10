"use server";

import { type SupportFormState, supportResponseDays, validateSupportRequest } from "@/lib/support";

/** splitforms' single submission endpoint. It accepts JSON and answers with JSON. */
const SUBMIT_ENDPOINT = "https://splitforms.com/api/submit";

function readField(data: FormData, name: string): string {
  const value = data.get(name);
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Send one support request to the splitforms inbox.
 *
 * The access key stays on the server. It is not a secret — splitforms says as
 * much — but keeping it out of the bundle means the form cannot be replayed
 * from a scraped page, and it lets us validate before spending the form's quota.
 */
export async function submitSupportRequest(
  _previous: SupportFormState,
  data: FormData,
): Promise<SupportFormState> {
  const values = {
    name: readField(data, "name"),
    email: readField(data, "email"),
    product: readField(data, "product"),
    topic: readField(data, "topic"),
    version: readField(data, "version"),
    message: readField(data, "message"),
  };

  // Honeypot. A real person never sees this field, so anything in it is a bot.
  // Answer as though it worked: telling a bot it failed only teaches it.
  if (readField(data, "botcheck")) {
    return {
      status: "sent",
      message: "Thanks — your request is on its way.",
      fieldErrors: {},
      values,
    };
  }

  const result = validateSupportRequest(values);

  if (!result.ok) {
    return {
      status: "error",
      message: "Some details need a second look before we can send this.",
      fieldErrors: result.fieldErrors,
      values,
    };
  }
  const request = result.request;

  const accessKey = process.env.SPLIT_FORMS_ACCESS_KEY;
  if (!accessKey) {
    console.error("SPLIT_FORMS_ACCESS_KEY is not set; support form cannot submit.");
    return {
      status: "error",
      message:
        "The form is misconfigured on our side and cannot send right now. Please open an issue on GitHub so this reaches us.",
      fieldErrors: {},
      values,
    };
  }

  try {
    const response = await fetch(SUBMIT_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
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
      }),
    });

    if (response.status === 429) {
      return {
        status: "error",
        message:
          "Too many requests from your connection just now. Wait a minute and send it again.",
        fieldErrors: {},
        values,
      };
    }
    if (!response.ok) {
      console.error(`splitforms rejected a support submission: HTTP ${response.status}`);
      return {
        status: "error",
        message:
          "We could not send that. Please try again in a moment; if it keeps failing, open an issue on GitHub.",
        fieldErrors: {},
        values,
      };
    }
  } catch (error) {
    console.error("splitforms submission failed", error);
    return {
      status: "error",
      message:
        "We could not reach our support inbox. Please try again in a moment; if it keeps failing, open an issue on GitHub.",
      fieldErrors: {},
      values,
    };
  }

  return {
    status: "sent",
    message: `Thanks — your request is with us. We reply within ${supportResponseDays} business days, to ${request.email}.`,
    fieldErrors: {},
    values,
  };
}

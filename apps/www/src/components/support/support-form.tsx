"use client";

import { useActionState, useId, useState } from "react";
import { CheckIcon } from "lucide-react";

import { submitSupportRequest } from "@/app/(home)/support/actions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  supportFormInitialState,
  type SupportFormState,
  supportProducts,
  type SupportRequestFields,
  supportResponseDays,
  supportTopics,
} from "@/lib/support";

/** One labelled field: label, optional hint, control, and the error slot they describe. */
function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-2">
      <Label htmlFor={id}>{label}</Label>
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground text-xs leading-[1.5]">
          {hint}
        </p>
      ) : null}
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-destructive text-xs leading-[1.5]">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Ties a control to whichever of its hint and error are actually rendered. */
function describedBy(id: string, hint: boolean, error: boolean): string | undefined {
  const ids = [hint && `${id}-hint`, error && `${id}-error`].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

/** What every field group needs: the form's id prefix, its errors, and its values. */
type FieldGroupProps = {
  id: string;
  errors: Record<string, string>;
  values: SupportRequestFields;
};

/** What each control shares: its id, its form `name`, and the copy around it. */
type ControlProps = {
  id: string;
  name: string;
  label: string;
  hint?: string;
  error?: string;
  value: string;
};

type TextFieldProps = ControlProps & React.ComponentProps<typeof Input>;

/** A text input wired to its label, hint, error, and echoed-back value. */
function TextField({ id, name, label, hint, error, value, ...input }: TextFieldProps) {
  return (
    <Field id={id} label={label} hint={hint} error={error}>
      <Input
        id={id}
        name={name}
        defaultValue={value}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy(id, Boolean(hint), Boolean(error))}
        {...input}
      />
    </Field>
  );
}

type SelectFieldProps = ControlProps & {
  placeholder: string;
  options: ReadonlyArray<{ value: string; label: string }>;
};

/** A choice field. Radix' select is uncontrolled here, re-seeded from `value`. */
function SelectField({ id, name, label, placeholder, options, error, value }: SelectFieldProps) {
  return (
    <Field id={id} label={label} error={error}>
      <Select name={name} required defaultValue={value || undefined}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-invalid={Boolean(error)}
          aria-describedby={describedBy(id, false, Boolean(error))}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  );
}

/** Hidden from sight and from assistive technology; only bots fill it. */
function Honeypot({ id }: { id: string }) {
  return (
    <div aria-hidden className="hidden">
      <label htmlFor={`${id}-botcheck`}>Leave this field empty</label>
      <input id={`${id}-botcheck`} name="botcheck" tabIndex={-1} autoComplete="off" />
    </div>
  );
}

/** Who is asking, and where the reply goes. */
function IdentityFields({ id, errors, values }: FieldGroupProps) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <TextField
        id={`${id}-name`}
        name="name"
        label="Your name"
        autoComplete="name"
        required
        error={errors.name}
        value={values.name}
      />
      <TextField
        id={`${id}-email`}
        name="email"
        label="Email address"
        type="email"
        inputMode="email"
        autoComplete="email"
        required
        error={errors.email}
        value={values.email}
      />
    </div>
  );
}

/** Which app, and what kind of request — the two fields that route the message. */
function RoutingFields({ id, errors, values }: FieldGroupProps) {
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      <SelectField
        id={`${id}-product`}
        name="product"
        label="Which app"
        placeholder="Choose an app"
        options={supportProducts}
        error={errors.product}
        value={values.product}
      />
      <SelectField
        id={`${id}-topic`}
        name="topic"
        label="What is this about"
        placeholder="Choose a topic"
        options={supportTopics}
        error={errors.topic}
        value={values.topic}
      />
    </div>
  );
}

/** The request itself: the optional environment line and the message. */
function DetailFields({ id, errors, values }: FieldGroupProps) {
  const messageId = `${id}-message`;
  const messageHint =
    "What you expected, what happened instead, and the steps that get there. Please leave out passwords, tokens, and anything you would not publish.";
  return (
    <>
      <TextField
        id={`${id}-version`}
        name="version"
        label="Version and system (optional)"
        hint="For example: Pragma 1.4.2 on macOS 26, or Pragma Go 1.2 on iPhone 15."
        autoComplete="off"
        error={errors.version}
        value={values.version}
      />
      <Field id={messageId} label="How can we help" hint={messageHint} error={errors.message}>
        <Textarea
          id={messageId}
          name="message"
          rows={8}
          required
          defaultValue={values.message}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={describedBy(messageId, true, Boolean(errors.message))}
        />
      </Field>
    </>
  );
}

/** What replaces the form once a request lands. */
function SupportSent({ message, onReset }: { message: string; onReset: () => void }) {
  return (
    <output className="border-border bg-card block rounded-xl border p-6" aria-live="polite">
      <p className="text-foreground flex items-center gap-2 text-sm font-medium">
        <CheckIcon aria-hidden className="size-4" />
        Request sent
      </p>
      <p className="text-muted-foreground mt-2 text-sm leading-[1.5]">{message}</p>
      <Button type="button" variant="outline" className="mt-6" onClick={onReset}>
        Send another request
      </Button>
    </output>
  );
}

/**
 * The support request form. It posts to a server action rather than to
 * splitforms directly, so the access key never enters the bundle and a request
 * is validated before it spends the form's monthly quota.
 *
 * The body is keyed so that "send another request" remounts it: `useActionState`
 * has no reset, and Radix' select holds its own state as well as the form's.
 */
export function SupportForm() {
  const [attempt, setAttempt] = useState(0);
  return <SupportFormBody key={attempt} onReset={() => setAttempt((value) => value + 1)} />;
}

/** The form's live region. Only an error has anything to announce. */
function FormStatus({ state }: { state: SupportFormState }) {
  const message = state.status === "error" ? state.message : "";
  return (
    <output aria-live="polite" className="block">
      {message ? <p className="text-destructive text-sm leading-[1.5]">{message}</p> : null}
    </output>
  );
}

/** Submit button and the reply commitment that sits beside it. */
function SubmitRow({ isPending }: { isPending: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-4">
      <Button type="submit" disabled={isPending}>
        {isPending ? "Sending…" : "Send request"}
      </Button>
      <p className="text-muted-foreground text-xs leading-[1.5]">
        We reply within {supportResponseDays} business days, to the email address you enter here.
      </p>
    </div>
  );
}

function SupportFormBody({ onReset }: { onReset: () => void }) {
  const [state, action, isPending] = useActionState<SupportFormState, FormData>(
    submitSupportRequest,
    supportFormInitialState,
  );
  const id = useId();
  const group = { id, errors: state.fieldErrors, values: state.values };

  if (state.status === "sent") {
    return <SupportSent message={state.message} onReset={onReset} />;
  }

  return (
    <form action={action} className="grid gap-6" noValidate>
      <Honeypot id={id} />
      <IdentityFields {...group} />
      <RoutingFields {...group} />
      <DetailFields {...group} />
      <FormStatus state={state} />
      <SubmitRow isPending={isPending} />
    </form>
  );
}

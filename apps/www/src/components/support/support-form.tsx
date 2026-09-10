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

function SupportFormBody({ onReset }: { onReset: () => void }) {
  const [state, action, isPending] = useActionState<SupportFormState, FormData>(
    submitSupportRequest,
    supportFormInitialState,
  );
  const id = useId();
  const errors = state.fieldErrors;
  const values = state.values;

  if (state.status === "sent") {
    return (
      <output className="border-border bg-card block rounded-xl border p-6" aria-live="polite">
        <p className="text-foreground flex items-center gap-2 text-sm font-medium">
          <CheckIcon aria-hidden className="size-4" />
          Request sent
        </p>
        <p className="text-muted-foreground mt-2 text-sm leading-[1.5]">{state.message}</p>
        <Button type="button" variant="outline" className="mt-6" onClick={onReset}>
          Send another request
        </Button>
      </output>
    );
  }

  return (
    <form action={action} className="grid gap-6" noValidate>
      {/* Honeypot. Hidden from sight and from assistive technology; only bots fill it. */}
      <div aria-hidden className="hidden">
        <label htmlFor={`${id}-botcheck`}>Leave this field empty</label>
        <input id={`${id}-botcheck`} name="botcheck" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field id={`${id}-name`} label="Your name" error={errors.name}>
          <Input
            id={`${id}-name`}
            name="name"
            autoComplete="name"
            required
            defaultValue={values.name}
            aria-invalid={Boolean(errors.name)}
            aria-describedby={describedBy(`${id}-name`, false, Boolean(errors.name))}
          />
        </Field>
        <Field id={`${id}-email`} label="Email address" error={errors.email}>
          <Input
            id={`${id}-email`}
            name="email"
            type="email"
            inputMode="email"
            autoComplete="email"
            required
            defaultValue={values.email}
            aria-invalid={Boolean(errors.email)}
            aria-describedby={describedBy(`${id}-email`, false, Boolean(errors.email))}
          />
        </Field>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Field id={`${id}-product`} label="Which app" error={errors.product}>
          <Select name="product" required defaultValue={values.product || undefined}>
            <SelectTrigger
              id={`${id}-product`}
              className="w-full"
              aria-invalid={Boolean(errors.product)}
              aria-describedby={describedBy(`${id}-product`, false, Boolean(errors.product))}
            >
              <SelectValue placeholder="Choose an app" />
            </SelectTrigger>
            <SelectContent>
              {supportProducts.map((product) => (
                <SelectItem key={product.value} value={product.value}>
                  {product.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id={`${id}-topic`} label="What is this about" error={errors.topic}>
          <Select name="topic" required defaultValue={values.topic || undefined}>
            <SelectTrigger
              id={`${id}-topic`}
              className="w-full"
              aria-invalid={Boolean(errors.topic)}
              aria-describedby={describedBy(`${id}-topic`, false, Boolean(errors.topic))}
            >
              <SelectValue placeholder="Choose a topic" />
            </SelectTrigger>
            <SelectContent>
              {supportTopics.map((topic) => (
                <SelectItem key={topic.value} value={topic.value}>
                  {topic.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </div>

      <Field
        id={`${id}-version`}
        label="Version and system (optional)"
        hint="For example: Pragma 1.4.2 on macOS 26, or Pragma Go 1.2 on iPhone 15."
        error={errors.version}
      >
        <Input
          id={`${id}-version`}
          name="version"
          autoComplete="off"
          defaultValue={values.version}
          aria-invalid={Boolean(errors.version)}
          aria-describedby={describedBy(`${id}-version`, true, Boolean(errors.version))}
        />
      </Field>

      <Field
        id={`${id}-message`}
        label="How can we help"
        hint="What you expected, what happened instead, and the steps that get there. Please leave out passwords, tokens, and anything you would not publish."
        error={errors.message}
      >
        <Textarea
          id={`${id}-message`}
          name="message"
          rows={8}
          required
          defaultValue={values.message}
          aria-invalid={Boolean(errors.message)}
          aria-describedby={describedBy(`${id}-message`, true, Boolean(errors.message))}
        />
      </Field>

      <output aria-live="polite" className="block">
        {state.status === "error" && state.message ? (
          <p className="text-destructive text-sm leading-[1.5]">{state.message}</p>
        ) : null}
      </output>

      <div className="flex flex-wrap items-center gap-4">
        <Button type="submit" disabled={isPending}>
          {isPending ? "Sending…" : "Send request"}
        </Button>
        <p className="text-muted-foreground text-xs leading-[1.5]">
          We reply within {supportResponseDays} business days, to the email address you enter here.
        </p>
      </div>
    </form>
  );
}

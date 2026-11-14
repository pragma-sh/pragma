// omp's form modules, resolved at runtime to the copy bundled in the running
// omp binary (see `loadOmpFormModules`). Typed loosely here and narrowed by
// the structural interfaces in `ask-form.ts`.
declare module "@oh-my-pi/pi-tui/html-form/parse" {
  export function parseHtmlForm(html: string): unknown;
}
declare module "@oh-my-pi/pi-tui/html-form/data" {
  export function fieldQuestions(form: unknown): Map<unknown, string>;
}

// Hand-written fixture plugin bundle (no build step). Mimics the shape
// `definePlugin` produces so it can be loaded directly via a blob-url
// `import()`, the same way a real compiled plugin bundle would be, without
// needing a bundler in the test fixture itself.
//
// `__apiVersion` is hardcoded to "0.0.0" to match `@pragma/plugin`'s current
// version — update this alongside `packages/plugin/package.json`'s version if
// it ever changes from "0.0.0".
export default {
  name: "Sample Plugin",
  description: "A hand-written fixture plugin for loader tests.",
  __apiVersion: "0.0.0",
  commands: [
    {
      id: "sample.hello",
      title: "Say hello",
      run(ctx) {
        ctx.notify("Hello from the sample plugin!");
      },
    },
  ],
};

import type { PackageManager } from "./package-manager";
import type { ScaffoldCapability } from "./scaffold";

interface TemplateInput {
  packageName: string;
  displayName: string;
  directoryName: string;
  packageManager: PackageManager;
  capabilities: readonly ScaffoldCapability[];
}

export interface TemplateFile {
  path: string;
  contents: string;
}

/** Returns the full file set for a generated Pragma plugin project. */
export function pluginTemplate(input: TemplateInput): TemplateFile[] {
  return [
    { path: "package.json", contents: packageJson(input) },
    { path: "tsconfig.json", contents: tsconfigJson() },
    { path: "vite.config.ts", contents: viteConfig() },
    { path: "README.md", contents: readme(input) },
    { path: "src/index.tsx", contents: source(input) },
    { path: "src/index.test.ts", contents: testSource() },
  ];
}

function packageJson(input: TemplateInput): string {
  return `${JSON.stringify(
    {
      name: input.packageName,
      version: "0.0.0",
      private: true,
      type: "module",
      main: "./dist/index.js",
      scripts: {
        build: "vite build",
        dev: "vite build --watch",
        typecheck: "tsc --noEmit",
        test: "vitest run",
      },
      dependencies: {
        "@pragma/plugin": "0.0.0",
      },
      devDependencies: {
        "@types/react": "^19.2.14",
        "@types/react-dom": "^19.2.3",
        "@vitejs/plugin-react": "^6.0.2",
        typescript: "^6.0.3",
        vite: "^8.0.16",
        vitest: "^4.1.8",
        react: "^19.2.6",
        "react-dom": "^19.2.6",
      },
    },
    null,
    2,
  )}\n`;
}

function tsconfigJson(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        jsxImportSource: "react",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
      },
      include: ["src"],
    },
    null,
    2,
  )}\n`;
}

function viteConfig(): string {
  return `import react from "@vitejs/plugin-react";\nimport { defineConfig } from "vite";\n\nexport default defineConfig({\n  plugins: [react()],\n  resolve: {\n    alias: {\n      "react/jsx-runtime": "@pragma/plugin/jsx-runtime",\n      "react-dom": "@pragma/plugin/react-dom",\n      react: "@pragma/plugin/react",\n    },\n  },\n  build: {\n    lib: {\n      entry: "src/index.tsx",\n      formats: ["es"],\n      fileName: "index",\n    },\n    rollupOptions: {\n      output: {\n        inlineDynamicImports: true,\n      },\n    },\n  },\n});\n`;
}

function source(input: TemplateInput): string {
  const hasCommand = input.capabilities.includes("commands");
  const commandImport = hasCommand ? ", defineCommand" : "";
  const commandContribution = hasCommand
    ? `,\n  commands: [\n    defineCommand({\n      id: "${input.packageName}.hello",\n      title: "Show ${input.displayName} greeting",\n      run: (ctx) => ctx.notify("Hello from ${input.displayName}", { variant: "success" }),\n    }),\n  ]`
    : "";
  return `import { definePlugin, defineSidebarTab, useProject${commandImport} } from "@pragma/plugin";\nimport { Button, Kbd } from "@pragma/plugin/ui";\n\nfunction OverviewTab() {\n  const project = useProject();\n  return (\n    <div style={{ padding: 12 }}>\n      <h2>${input.displayName}</h2>\n      <p>Active project: {project?.name ?? "None"}</p>\n      <Button variant="secondary" size="sm">\n        Press <Kbd>⌘K</Kbd>\n      </Button>\n    </div>\n  );\n}\n\nexport default definePlugin({\n  name: "${input.displayName}",\n  description: "A Pragma plugin scaffolded with create-pragma-plugin.",\n  ui: {\n    sidebarTabs: [\n      defineSidebarTab({\n        id: "overview",\n        title: "${input.displayName}",\n        component: OverviewTab,\n      }),\n    ],\n  }${commandContribution},\n});\n`;
}

function testSource(): string {
  return `import { describe, expect, it } from "vitest";\n\nimport plugin from "./index";\n\ndescribe("plugin", () => {\n  it("exports a stamped Pragma plugin", () => {\n    expect(plugin.__apiVersion).toBeTypeOf("string");\n    expect(plugin.name).toBeTypeOf("string");\n  });\n});\n`;
}

function readme(input: TemplateInput): string {
  const install =
    input.packageManager === "npm" ? "npm install" : `${input.packageManager} install`;
  const run = input.packageManager === "npm" ? "npm run" : `${input.packageManager} run`;
  return `# ${input.displayName}\n\nA Pragma plugin scaffolded with \`create-pragma-plugin\`.\n\n## Quick Start\n\n\`\`\`bash\n${install}\n${run} build\n\`\`\`\n\n## Load In Pragma\n\nAdd this to your project's \`.pragma/config.json\`:\n\n\`\`\`json\n{\n  "plugins": [{ "path": "./${input.directoryName}" }]\n}\n\`\`\`\n\nPragma loads local plugin code from this path. Only add plugins you trust.\n\n## Commands\n\n\`\`\`bash\n${run} dev\n${run} typecheck\n${run} test\n${run} build\n\`\`\`\n`;
}

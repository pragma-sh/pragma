import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition, ThemeDefinition } from "@pragma/plugin";

import { ThemeSection } from "./ThemeSection";
import { writeTheme } from "@/lib/tauri";
import { parseThemeFile, type ThemeFile } from "@/lib/theme";
import { THEME_OPTIONS, THEME_PRESETS, isThemePreset } from "@/lib/theme-presets";
import { THEME_DEFAULTS } from "@/lib/theme-tokens";
import { useTheme } from "@/state/theme-context";
import { clearPlugins, setPluginsForScope } from "@/plugins/registry";

vi.mock("@/lib/tauri", () => ({ writeTheme: vi.fn() }));
vi.mock("@/state/theme-context", () => ({ useTheme: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

const useThemeMock = vi.mocked(useTheme);
const writeThemeMock = vi.mocked(writeTheme);

function mockTheme(global: ThemeFile | null = null, project: ThemeFile | null = null) {
  useThemeMock.mockReturnValue({ global, project, errors: {}, reload: vi.fn() });
}

/** The `<li>` for a token row, located by its `--token` caption. */
function row(token: string): HTMLElement {
  const caption = screen.getByText(new RegExp(`^--${token} · `));
  const item = caption.closest("li");
  if (!item) throw new Error(`no row for --${token}`);
  return item;
}

describe("ThemeSection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPlugins();
    writeThemeMock.mockResolvedValue();
  });

  it("shows the stylesheet default when nothing is overridden", () => {
    mockTheme();
    render(<ThemeSection projectId={null} scope="global" />);

    const primary = row("primary");
    expect(within(primary).getByText("Default")).toBeInTheDocument();
    expect(primary).toHaveTextContent(THEME_DEFAULTS.dark.primary ?? "");
    expect(within(primary).getByRole("button", { name: /^Reset Primary$/ })).toBeDisabled();
  });

  it("lists Pragma and ten sourced presets and writes both color modes when selected", async () => {
    mockTheme({ $schema: "./theme.schema.json" });
    render(<ThemeSection projectId={null} scope="global" />);

    for (const preset of THEME_OPTIONS) {
      expect(
        screen.getByRole("button", { name: new RegExp(`^${preset.name}`) }),
      ).toBeInTheDocument();
    }

    fireEvent.click(screen.getByRole("button", { name: /^GitHub/ }));
    await waitFor(() => expect(writeThemeMock).toHaveBeenCalledTimes(1));
    const [, contents] = writeThemeMock.mock.calls[0] ?? [];
    const file = parseThemeFile(String(contents));
    expect(file.$schema).toBe("./theme.schema.json");
    expect(file.colors?.light?.primary).toMatch(/^oklch\(/);
    expect(file.colors?.dark?.primary).toMatch(/^oklch\(/);
    const github = THEME_PRESETS[0];
    if (!github) throw new Error("missing GitHub theme preset");
    expect(isThemePreset(file, github)).toBe(true);
  });

  it("marks a scoped override as custom and resets it back to the default", async () => {
    mockTheme(parseThemeFile(JSON.stringify({ colors: { dark: { primary: "#ff0000" } } })));
    render(<ThemeSection projectId={null} scope="global" />);

    const primary = row("primary");
    expect(within(primary).getByText("Custom")).toBeInTheDocument();
    expect(primary).toHaveTextContent("#ff0000");

    fireEvent.click(within(primary).getByRole("button", { name: /^Reset Primary$/ }));
    await waitFor(() => expect(writeThemeMock).toHaveBeenCalledTimes(1));
    const [scope, contents, projectId] = writeThemeMock.mock.calls[0] ?? [];
    expect(scope).toBe("global");
    expect(projectId).toBeNull();
    expect(parseThemeFile(String(contents)).colors).toBeUndefined();
  });

  it("reports a global value inherited by the project scope, and does not offer a reset", () => {
    mockTheme(parseThemeFile(JSON.stringify({ colors: { dark: { ring: "#00ff00" } } })), null);
    render(<ThemeSection projectId="project-1" scope="project" />);

    const ring = row("ring");
    expect(within(ring).getByText("From global")).toBeInTheDocument();
    expect(within(ring).getByRole("button", { name: /^Reset Ring$/ })).toBeDisabled();
  });

  it("switches to the light ramp and previews it on the document", () => {
    document.documentElement.classList.add("dark");
    mockTheme();
    const view = render(<ThemeSection projectId={null} scope="global" />);

    fireEvent.click(screen.getByRole("button", { name: "Light" }));
    expect(row("background")).toHaveTextContent(THEME_DEFAULTS.light.background ?? "");
    expect(document.documentElement).not.toHaveClass("dark");

    view.unmount();
    expect(document.documentElement).toHaveClass("dark");
  });

  it("lists active plugin themes and copies the selected colors into the scope", async () => {
    const theme = {
      id: "ocean",
      name: "Ocean",
      description: "Cool blue palette",
      colors: {
        light: { background: "#ffffff", primary: "#0066cc" },
        dark: { background: "#001122", primary: "#66ccff" },
      },
    } satisfies ThemeDefinition;
    setPluginsForScope("global", null, [
      {
        pluginId: "example.themes",
        version: "1.0.0",
        scope: "global",
        status: "loaded",
        definition: {
          name: "Example Themes",
          themes: [theme],
          __apiVersion: "0.3.0",
        } satisfies PluginDefinition,
        config: undefined,
      },
    ]);
    mockTheme({ $schema: "./theme.schema.json" });
    render(<ThemeSection projectId={null} scope="global" />);

    expect(screen.getByRole("button", { name: /^Ocean/ })).toBeInTheDocument();
    expect(screen.getByText("example.themes")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^Ocean/ }));
    await waitFor(() => expect(writeThemeMock).toHaveBeenCalledTimes(1));
    const [, contents] = writeThemeMock.mock.calls[0] ?? [];
    const file = parseThemeFile(String(contents));
    expect(file.$schema).toBe("./theme.schema.json");
    expect(file.colors).toEqual(theme.colors);
  });
});

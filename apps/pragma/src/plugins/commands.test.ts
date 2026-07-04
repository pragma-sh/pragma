import { createElement } from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { PluginDefinition } from "@pragma/plugin";

import {
  clearActivePluginCommandKeybindings,
  commandForEvent,
  hasPluginCommandForEvent,
  setActivePluginCommandKeybindings,
} from "./command-keybindings";
import { PluginCommandKeybindings, resolvePluginCommands } from "./commands";
import { setPluginRuntimeSdk } from "./host-hooks";
import { clearPlugins, setPluginsForScope, type PluginRecord } from "./registry";

function record(definition: PluginDefinition): PluginRecord {
  return {
    pluginId: "plugin-a",
    version: "1.0.0",
    scope: "global",
    status: "loaded",
    config: undefined,
    definition,
  };
}

afterEach(() => {
  clearActivePluginCommandKeybindings();
  clearPlugins();
  setPluginRuntimeSdk(null);
});

describe("resolvePluginCommands", () => {
  it("layers command defaults and plugin keybinding overrides with provenance", () => {
    const command = { id: "run", title: "Run", defaultBinding: "cmd+r", run: () => {} };
    const definition = {
      name: "plugin-a",
      commands: [command],
      keybindings: { bindings: { run: "cmd+shift+r" } },
      __apiVersion: "1.0.0",
    } as PluginDefinition;

    expect(resolvePluginCommands([record(definition)])).toEqual([
      {
        pluginId: "plugin-a",
        record: record(definition),
        command,
        bindings: [
          { commandId: "plugin-a.run", pluginId: "plugin-a", chord: "cmd+r", source: "command" },
          {
            commandId: "plugin-a.run",
            pluginId: "plugin-a",
            chord: "cmd+shift+r",
            source: "keybindings",
          },
        ],
      },
    ]);
  });

  it("ignores failed plugin records", () => {
    expect(
      resolvePluginCommands([
        { ...record({ name: "x", __apiVersion: "1.0.0" } as PluginDefinition), status: "failed" },
      ]),
    ).toEqual([]);
  });
});

describe("plugin command keybindings", () => {
  it("matches command bindings", () => {
    const commands = resolvePluginCommands([
      record({
        name: "plugin-a",
        commands: [{ id: "run", title: "Run", defaultBinding: "cmd+r", run: () => {} }],
        __apiVersion: "1.0.0",
      } as PluginDefinition),
    ]);

    expect(
      commandForEvent(commands, new KeyboardEvent("keydown", { metaKey: true, key: "r" })),
    ).toBe(commands[0]);
    expect(
      commandForEvent(commands, new KeyboardEvent("keydown", { ctrlKey: true, key: "r" })),
    ).toBeNull();
  });

  it("maps mod to the current platform modifier", () => {
    Object.defineProperty(window.navigator, "platform", { value: "MacIntel", configurable: true });
    const commands = [{ bindings: [{ chord: "mod+shift+p" }] }];

    expect(
      commandForEvent(
        commands,
        new KeyboardEvent("keydown", { metaKey: true, shiftKey: true, key: "p" }),
      ),
    ).toBe(commands[0]);
    expect(
      commandForEvent(
        commands,
        new KeyboardEvent("keydown", { ctrlKey: true, shiftKey: true, key: "p" }),
      ),
    ).toBeNull();
  });

  it("exposes active bindings for non-React key handlers", () => {
    setActivePluginCommandKeybindings([{ bindings: [{ chord: "cmd+y" }] }]);

    expect(
      hasPluginCommandForEvent(new KeyboardEvent("keydown", { metaKey: true, key: "y" })),
    ).toBe(true);
    expect(
      hasPluginCommandForEvent(new KeyboardEvent("keydown", { metaKey: true, key: "u" })),
    ).toBe(false);
  });

  it("runs plugin shortcuts from terminal focus but not regular text input", async () => {
    const run = vi.fn();
    setPluginRuntimeSdk({} as never);
    setPluginsForScope("global", null, [
      record({
        name: "plugin-a",
        commands: [{ id: "run", title: "Run", defaultBinding: "cmd+y", run }],
        __apiVersion: "1.0.0",
      } as PluginDefinition),
    ]);
    render(createElement(PluginCommandKeybindings, { activeProjectId: null }));

    const textarea = document.createElement("textarea");
    document.body.append(textarea);
    textarea.focus();
    const inputEvent = new KeyboardEvent("keydown", { cancelable: true, metaKey: true, key: "y" });
    window.dispatchEvent(inputEvent);

    const xterm = document.createElement("div");
    xterm.className = "xterm";
    const helperTextarea = document.createElement("textarea");
    xterm.appendChild(helperTextarea);
    document.body.append(xterm);
    helperTextarea.focus();
    const terminalEvent = new KeyboardEvent("keydown", {
      cancelable: true,
      metaKey: true,
      key: "y",
    });
    window.dispatchEvent(terminalEvent);

    await vi.waitFor(() => expect(run).toHaveBeenCalledTimes(1));
    expect(inputEvent.defaultPrevented).toBe(false);
    expect(terminalEvent.defaultPrevented).toBe(true);
  });
});

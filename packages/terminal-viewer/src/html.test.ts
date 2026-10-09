import { describe, expect, it } from "vitest";

import { buildTerminalViewerHtml, terminalCommandScript, terminalThemeCss } from "./html";

describe("buildTerminalViewerHtml", () => {
  it("inlines the runtime and its stylesheet, fetching nothing", () => {
    const html = buildTerminalViewerHtml();

    expect(html).toContain('<div id="terminal">');
    expect(html).toContain("<script>");
    // A document loaded from a string has no origin to resolve against, so any
    // external reference here would simply never load.
    expect(html).not.toMatch(/<script[^>]+src=/);
    expect(html).not.toMatch(/<link[^>]+href=/);
  });

  it("renders in the host's color scheme", () => {
    expect(buildTerminalViewerHtml({ mode: "light" })).toContain('<html class="light"');
    expect(buildTerminalViewerHtml()).toContain('<html class="dark"');
  });
});

describe("terminalThemeCss", () => {
  it("passes the terminal color tokens through", () => {
    expect(
      terminalThemeCss({ "terminal-background": "#09090b", "terminal-foreground": "#fafafa" }),
    ).toBe(":root{--terminal-background: #09090b;--terminal-foreground: #fafafa;}");
  });

  it("ignores tokens the document does not read", () => {
    expect(terminalThemeCss({ "card-foreground": "#fff" })).toBe("");
  });

  it("refuses a value that would smuggle extra CSS into the document", () => {
    expect(terminalThemeCss({ "terminal-background": "#fff;} body{display:none" })).toBe("");
    expect(terminalThemeCss({ "terminal-cursor": "url(https://example.com/x)" })).toBe("");
  });

  it("accepts the color functions a real palette uses", () => {
    expect(terminalThemeCss({ "terminal-selection": "rgba(120,120,140,0.35)" })).toContain(
      "rgba(120,120,140,0.35)",
    );
    expect(terminalThemeCss({ "terminal-foreground": "oklch(0.98 0 0)" })).toContain("oklch");
  });

  it("returns nothing when there is nothing to override", () => {
    expect(terminalThemeCss({ "terminal-background": undefined })).toBe("");
  });
});

describe("terminalCommandScript", () => {
  it("passes the command as a string literal the document parses itself", () => {
    const script = terminalCommandScript({ type: "write", dataBase64: "aGk=" });

    expect(script).toContain("window.pragmaTerminalCommand");
    // The payload is a quoted string, not spliced-in JavaScript: terminal
    // output ends up in these commands, and it is not source code.
    expect(script).toContain(JSON.stringify(JSON.stringify({ type: "write", dataBase64: "aGk=" })));
    expect(script.endsWith("true;")).toBe(true);
  });

  it("round-trips a payload that would otherwise break out of the literal", () => {
    const command = { type: "paste", text: '");alert(1);//' };

    const script = terminalCommandScript(command);

    // Whatever quoting the text carries, the argument stays exactly one string
    // literal, and parsing it twice returns the command unchanged.
    const literal = script.slice(
      script.indexOf("(", script.indexOf("&&")) + 1,
      script.lastIndexOf(")"),
    );
    expect(JSON.parse(JSON.parse(literal) as string)).toEqual(command);
  });
});

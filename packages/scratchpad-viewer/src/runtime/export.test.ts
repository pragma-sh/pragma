// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildScratchpadExportHtml } from "../html";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("standalone scratchpad export", () => {
  it("runs offline, preserves local interaction, and disables agent feedback", async () => {
    const post = vi.spyOn(window, "postMessage");
    const html = buildScratchpadExportHtml({
      title: "Plan <offline>",
      css: "",
      mode: "dark",
      themeCss: ":root{--foreground:white}",
      code: `const {React:R,ReactDomClient:D,ScratchpadUi:UI}=globalThis.pragmaScratchpadFrame;
      function Counter(){const [n,set]=R.useState(0);return R.createElement("button",{id:"counter",onClick:()=>set(n+1)},"count "+n)}
      D.createRoot(document.getElementById("root")).render(R.createElement(R.Fragment,null,
        R.createElement(Counter),R.createElement(UI.AskQuestion,{question:"Proceed?",type:"yes-no"}),
        R.createElement(UI.AskQuestion,{question:"Notes?",type:"text"}),
        R.createElement(UI.DiffReview,{title:"Change",before:"old",after:"new"})));`,
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.title).toBe("Plan <offline>");
    expect(parsed.querySelector("script[src],link[href]")).toBeNull();
    document.body.innerHTML = '<div id="root"></div>';
    for (const script of parsed.querySelectorAll("script"))
      new Function(script.textContent ?? "")();
    await vi.waitFor(() => expect(document.getElementById("counter")?.textContent).toBe("count 0"));
    document.getElementById("counter")?.click();
    await vi.waitFor(() => expect(document.getElementById("counter")?.textContent).toBe("count 1"));
    const choice = document.querySelector<HTMLInputElement>('input[type="radio"]');
    expect(choice?.disabled).toBe(false);
    expect(document.querySelector<HTMLTextAreaElement>("textarea")?.disabled).toBe(false);
    choice?.click();
    await vi.waitFor(() => expect(choice?.checked).toBe(true));
    for (const button of document.querySelectorAll<HTMLButtonElement>("button:not(#counter)"))
      expect(button.disabled).toBe(true);
    expect(await globalThis.pragmaScratchpad?.promptAgent("feedback")).toBe("cancelled");
    expect(post).not.toHaveBeenCalled();
    post.mockRestore();
  });

  it("adds a visible Created with Pragma watermark to every export", () => {
    const html = buildScratchpadExportHtml({
      title: "Export",
      css: "",
      mode: "light",
      themeCss: "",
      code: "",
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.querySelector("footer[data-pragma-export-watermark]")?.textContent).toBe(
      "Created with Pragma",
    );
    const link = parsed.querySelector<HTMLAnchorElement>("footer[data-pragma-export-watermark] a");
    expect(link?.href).toBe("https://pragma-app.sh/");
    expect(link?.target).toBe("_blank");
  });

  it("keeps script-closing content inside the bundled script", () => {
    const html = buildScratchpadExportHtml({
      title: "Export",
      css: "",
      mode: "light",
      themeCss: "",
      code: 'globalThis.test="</ScRiPt><p>oops</p>";',
    });
    const parsed = new DOMParser().parseFromString(html, "text/html");
    expect(parsed.querySelector("p")).toBeNull();
    expect(parsed.querySelectorAll("script")).toHaveLength(3);
  });
});

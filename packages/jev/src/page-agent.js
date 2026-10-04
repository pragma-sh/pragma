// The half of jev that runs inside the Pragma dev webview.
//
// Injected through the Tauri dev bridge as `(<this file>)(command)` on every
// call, so it holds no closure state between calls: anything that must survive
// (the element index from the last snapshot) lives on `window`. It reads the
// live DOM and dispatches the same pointer, mouse, keyboard, wheel, and input
// events a person's hands would produce, at real coordinates, so React, Radix,
// and xterm handle them through their ordinary listeners.
//
// The terminal is an xterm.js widget painted on a WebGL <canvas>: the DOM holds
// no text for it. Its text is read from the dev-only terminal hook
// (`constants.bench.hookGlobal`), and typing reaches it by focusing xterm's
// hidden helper textarea — which is what clicking the canvas does for a user.
/* oxlint-disable unicorn/consistent-function-scoping -- the file is evaluated as
   a single expression inside the webview, so its IIFE *is* the outer scope; a
   helper hoisted out of it would become a global in the app's page. */
(() => {
  const command = __JEV_COMMAND__;
  const STATE_KEY = "__JEV_PAGE_STATE__";
  const MAX_ELEMENTS = 400;
  const MAX_TEXTS = 150;
  const MAX_LABEL = 80;
  const MAX_TERMINAL_LINES = 60;

  const INTERACTIVE = [
    "a[href]",
    "button",
    "input",
    "textarea",
    "select",
    "summary",
    "label[for]",
    "[role=button]",
    "[role=link]",
    "[role=tab]",
    "[role=menuitem]",
    "[role=menuitemcheckbox]",
    "[role=menuitemradio]",
    "[role=option]",
    "[role=checkbox]",
    "[role=radio]",
    "[role=switch]",
    "[role=treeitem]",
    "[role=combobox]",
    "[role=textbox]",
    "[role=slider]",
    "[role=gridcell]",
    "[contenteditable='']",
    "[contenteditable=true]",
    "[tabindex]:not([tabindex='-1'])",
    "[data-tour]",
  ].join(",");

  const FOCUSABLE =
    "a[href],button:not([disabled]),input:not([disabled]),textarea:not([disabled]),select:not([disabled]),[contenteditable=''],[contenteditable=true],[tabindex]";

  const state = window[STATE_KEY] || (window[STATE_KEY] = { elements: [] });

  // ---------------------------------------------------------------- reading

  function collapse(text, max) {
    const value = String(text || "")
      .replace(/\s+/g, " ")
      .trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  function inViewport(rect) {
    const sized = rect.width >= 1 && rect.height >= 1;
    const overlaps =
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < window.innerHeight &&
      rect.left < window.innerWidth;
    return sized && overlaps;
  }

  function isRendered(style) {
    return style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) !== 0;
  }

  function isVisible(element) {
    return inViewport(element.getBoundingClientRect()) && isRendered(getComputedStyle(element));
  }

  function hitPoint(element) {
    const rect = element.getBoundingClientRect();
    const left = Math.max(rect.left, 0);
    const top = Math.max(rect.top, 0);
    const right = Math.min(rect.right, window.innerWidth);
    const bottom = Math.min(rect.bottom, window.innerHeight);
    const probes = [
      [0.5, 0.5],
      [0.25, 0.5],
      [0.75, 0.5],
      [0.5, 0.25],
      [0.5, 0.75],
      [0.15, 0.15],
    ];
    for (const [fx, fy] of probes) {
      const x = left + (right - left) * fx;
      const y = top + (bottom - top) * fy;
      const hit = document.elementFromPoint(x, y);
      if (hit && (hit === element || element.contains(hit) || hit.contains(element))) {
        return { x, y, target: hit, covered: false };
      }
    }
    const x = left + (right - left) / 2;
    const y = top + (bottom - top) / 2;
    return { x, y, target: element, covered: true };
  }

  function labelledByText(element) {
    const ids = element.getAttribute("aria-labelledby");
    if (!ids) return "";
    return ids
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent || "")
      .join(" ");
  }

  function attributeLabel(element) {
    const names = ["aria-label", "title", "placeholder", "alt"];
    return names.map((name) => element.getAttribute(name)).find(Boolean) || "";
  }

  function fieldLabel(element) {
    return element.tagName === "INPUT" ? element.labels?.[0]?.textContent || "" : "";
  }

  function iconLabel(element) {
    const icon = element.querySelector("svg[aria-label], img[alt]");
    if (icon) return icon.getAttribute("aria-label") || icon.getAttribute("alt");
    const lucide = /lucide-([a-z0-9-]+)/.exec(
      element.querySelector("svg")?.getAttribute("class") || "",
    );
    return lucide ? `icon:${lucide[1]}` : "";
  }

  // The first source that names the element wins, in the order a screen reader
  // would consult them, with icons as the last resort for icon-only buttons.
  function labelOf(element) {
    const sources = [
      labelledByText,
      attributeLabel,
      fieldLabel,
      (node) => node.innerText || node.textContent,
      iconLabel,
    ];
    for (const source of sources) {
      const label = collapse(source(element), MAX_LABEL);
      if (label) return label;
    }
    return "";
  }

  function isEditable(element) {
    if (!element) return false;
    if (element.isContentEditable) return true;
    if (element.tagName === "TEXTAREA") return true;
    if (element.tagName !== "INPUT") return false;
    return !/^(button|checkbox|radio|submit|reset|file|color|range|image|hidden)$/i.test(
      element.type,
    );
  }

  function isTerminalElement(element) {
    return Boolean(element && element.closest && element.closest(".xterm"));
  }

  const STATE_ATTRIBUTES = [
    "aria-expanded",
    "aria-selected",
    "aria-checked",
    "aria-pressed",
    "aria-current",
    "data-state",
  ];

  function boxOf(element) {
    const rect = element.getBoundingClientRect();
    return [
      Math.round(rect.left),
      Math.round(rect.top),
      Math.round(rect.width),
      Math.round(rect.height),
    ];
  }

  function valueFields(element) {
    if (element.tagName === "SELECT") {
      return {
        value: element.value,
        options: [...element.options].slice(0, 20).map((option) => option.label),
      };
    }
    if (!isEditable(element)) return {};
    const value = element.isContentEditable ? element.innerText : element.value;
    return value ? { editable: true, value: collapse(value, 120) } : { editable: true };
  }

  function stateFields(element) {
    const fields = {};
    for (const attribute of STATE_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value) fields[attribute.replace(/^(aria|data)-/, "")] = value;
    }
    return fields;
  }

  function flagFields(element, hit) {
    const flags = {
      checked: Boolean(element.checked),
      disabled: Boolean(element.disabled) || element.getAttribute("aria-disabled") === "true",
      focused: element === document.activeElement,
      covered: hit.covered,
    };
    return Object.fromEntries(Object.entries(flags).filter(([, on]) => on));
  }

  // Undefined fields vanish in the JSON the bridge sends back, so optional
  // facts are simply left undefined rather than branched on.
  function describe(element, index, hit) {
    return {
      index,
      kind: "element",
      tag: element.tagName.toLowerCase(),
      label: labelOf(element),
      role: element.getAttribute("role") || undefined,
      type: element.tagName === "INPUT" ? element.type : undefined,
      tour: element.getAttribute("data-tour") || undefined,
      ...valueFields(element),
      ...stateFields(element),
      ...flagFields(element, hit),
      box: boxOf(element),
    };
  }

  function hasPointerCursor(element) {
    if (getComputedStyle(element).cursor !== "pointer") return false;
    const parent = element.parentElement;
    return !parent || getComputedStyle(parent).cursor !== "pointer";
  }

  function candidates() {
    const seen = new Set();
    const result = [];
    const consider = (element) => {
      if (seen.has(element) || isTerminalElement(element)) return;
      seen.add(element);
      result.push(element);
    };
    document.querySelectorAll(INTERACTIVE).forEach(consider);
    // React attaches click handlers invisibly; a pointer cursor is the best
    // remaining signal that a plain <div> is meant to be clicked.
    document.querySelectorAll("body *").forEach((element) => {
      if (!seen.has(element) && hasPointerCursor(element)) consider(element);
    });
    return result;
  }

  function terminalHook() {
    const hook = window[command.hookGlobal];
    return hook && typeof hook.tabs === "function" ? hook : null;
  }

  function terminalLines(terminal, full) {
    const buffer = terminal.buffer.active;
    const start = full ? 0 : buffer.viewportY;
    const end = full ? buffer.length : buffer.viewportY + terminal.rows;
    const lines = [];
    for (let row = start; row < end; row += 1) {
      lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
    }
    while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines;
  }

  function terminals(full) {
    const hook = terminalHook();
    if (!hook) return [];
    const result = [];
    for (const tabId of hook.tabs()) {
      const element = hook.element(tabId);
      const terminal = hook.terminal(tabId);
      if (!element || !terminal) continue;
      const visible = element.isConnected && isVisible(element);
      if (!visible && !full) continue;
      const buffer = terminal.buffer.active;
      const lines = terminalLines(terminal, full);
      result.push({
        tabId,
        visible,
        focused: element.contains(document.activeElement),
        cols: terminal.cols,
        rows: terminal.rows,
        cursor: [buffer.cursorX, buffer.cursorY],
        lines: full ? lines : lines.slice(-MAX_TERMINAL_LINES),
        element,
      });
    }
    return result;
  }

  function insideListed(listed, element) {
    for (let node = element; node; node = node.parentElement) {
      if (listed.has(node)) return true;
    }
    return false;
  }

  // Text worth reporting on its own: visible, not already the label of a
  // listed element, and not inside the terminal (which is reported separately).
  function readableText(node, listed) {
    const parent = node.parentElement;
    if (!parent || !node.textContent.trim()) return "";
    const skipped =
      isTerminalElement(parent) ||
      parent.closest("script,style,noscript") ||
      insideListed(listed, parent);
    if (skipped || !isVisible(parent)) return "";
    return collapse(parent.innerText || node.textContent, 120);
  }

  function visibleTexts(listed) {
    const seen = new Set();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node && seen.size < MAX_TEXTS; node = walker.nextNode()) {
      const text = readableText(node, listed);
      if (text) seen.add(text);
    }
    return [...seen];
  }

  function dialogs() {
    return [...document.querySelectorAll("[role=dialog],[role=alertdialog]")]
      .filter(isVisible)
      .map((element) => {
        const heading = element.querySelector("h1,h2,h3,[id$='title']");
        return collapse(element.getAttribute("aria-label") || heading?.textContent || "dialog", 80);
      });
  }

  function focusedDescription() {
    const element = document.activeElement;
    if (!element || element === document.body) return "nothing (document body)";
    if (isTerminalElement(element)) return "the terminal (typing goes to the shell)";
    const index = state.elements.indexOf(element);
    const label = labelOf(element);
    return `${element.tagName.toLowerCase()}${label ? ` "${label}"` : ""}${index >= 0 ? ` [${index}]` : ""}`;
  }

  function snapshot() {
    const listed = new Set();
    const entries = [];
    state.elements = [];
    for (const element of candidates()) {
      if (entries.length >= MAX_ELEMENTS) break;
      if (!isVisible(element)) continue;
      const index = state.elements.length;
      state.elements.push(element);
      listed.add(element);
      entries.push(describe(element, index, hitPoint(element)));
    }
    const shells = [];
    for (const { element, ...rest } of terminals(false)) {
      shells.push(
        Object.assign(rest, {
          index: state.elements.length,
          kind: "terminal",
          box: boxOf(element),
        }),
      );
      state.elements.push(element);
    }
    return {
      title: document.title,
      url: location.href,
      viewport: [window.innerWidth, window.innerHeight],
      windowFocused: document.hasFocus(),
      focused: focusedDescription(),
      dialogs: dialogs(),
      elements: entries,
      terminals: shells,
      texts: visibleTexts(listed),
    };
  }

  // ----------------------------------------------------------------- acting

  function byIndex(index) {
    const element = state.elements[index];
    if (!element) throw new Error(`no element [${index}]; take a fresh snapshot`);
    if (!element.isConnected)
      throw new Error(`element [${index}] is gone from the page; take a fresh snapshot`);
    return element;
  }

  function bySelector(selector) {
    const element = document.querySelector(selector);
    if (!element) throw new Error(`no element matches ${selector}`);
    return element;
  }

  function atPoint(x, y) {
    const hit = document.elementFromPoint(x, y);
    if (!hit) throw new Error(`nothing at (${x}, ${y})`);
    return { element: hit, x, y, target: hit };
  }

  function hasTarget(target) {
    return typeof target.index === "number" || typeof target.selector === "string";
  }

  function resolve(target) {
    if (!hasTarget(target)) {
      if (typeof target.x === "number" && typeof target.y === "number")
        return atPoint(target.x, target.y);
      throw new Error("a target needs an index, a selector, or x and y");
    }
    const element =
      typeof target.index === "number" ? byIndex(target.index) : bySelector(target.selector);
    if (!isVisible(element)) element.scrollIntoView({ block: "center", inline: "center" });
    // A terminal is clicked on its screen (the canvas), like a user would.
    const surface = element.querySelector?.(".xterm-screen") || element;
    const point = hitPoint(surface);
    return { element, x: point.x, y: point.y, target: point.target };
  }

  function modifiers(options) {
    return {
      ctrlKey: Boolean(options.ctrlKey),
      metaKey: Boolean(options.metaKey),
      altKey: Boolean(options.altKey),
      shiftKey: Boolean(options.shiftKey),
    };
  }

  function fire(type, target, x, y, extra) {
    const init = {
      bubbles: !/^(pointerenter|pointerleave|mouseenter|mouseleave)$/.test(type),
      cancelable: true,
      composed: true,
      view: window,
      clientX: x,
      clientY: y,
      screenX: window.screenX + x,
      screenY: window.screenY + y,
      ...extra,
    };
    const event = type.startsWith("pointer")
      ? new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, ...init })
      : new MouseEvent(type, init);
    return target.dispatchEvent(event);
  }

  function moveTo(target, x, y, extra) {
    fire("pointerover", target, x, y, extra);
    fire("pointerenter", target, x, y, extra);
    fire("mouseover", target, x, y, extra);
    fire("mouseenter", target, x, y, extra);
    fire("pointermove", target, x, y, extra);
    fire("mousemove", target, x, y, extra);
  }

  function focusFor(target) {
    const focusable = target.closest(FOCUSABLE);
    if (focusable) {
      focusable.focus({ preventScroll: true });
    } else if (document.activeElement && document.activeElement !== document.body) {
      document.activeElement.blur();
    }
  }

  function press(target, x, y, button, detail, mods) {
    const buttons = button === 2 ? 2 : 1;
    const down = { button, buttons, detail, ...mods };
    const up = { button, buttons: 0, detail, ...mods };
    fire("pointerdown", target, x, y, down);
    if (fire("mousedown", target, x, y, down)) focusFor(target);
    fire("pointerup", target, x, y, up);
    fire("mouseup", target, x, y, up);
  }

  function focusTerminal(element) {
    const textarea = element.querySelector(".xterm-helper-textarea");
    if (textarea) textarea.focus({ preventScroll: true });
  }

  function click(options) {
    const { element, x, y, target } = resolve(options);
    const mods = modifiers(options);
    const button = options.button === "right" ? 2 : 0;
    moveTo(target, x, y, mods);
    press(target, x, y, button, 1, mods);
    if (button === 2) {
      fire("contextmenu", target, x, y, { button: 2, buttons: 0, ...mods });
    } else {
      fire("click", target, x, y, { button: 0, buttons: 0, detail: 1, ...mods });
      if (options.double) {
        press(target, x, y, 0, 2, mods);
        fire("click", target, x, y, { button: 0, buttons: 0, detail: 2, ...mods });
        fire("dblclick", target, x, y, { button: 0, buttons: 0, detail: 2, ...mods });
      }
    }
    if (isTerminalElement(target) || element.querySelector?.(".xterm")) {
      focusTerminal(element.closest(".xterm") ? element : element.querySelector(".xterm"));
    }
    return {
      clicked: describeTarget(element),
      at: [Math.round(x), Math.round(y)],
      focused: focusedDescription(),
    };
  }

  function hover(options) {
    const { element, x, y, target } = resolve(options);
    moveTo(target, x, y, {});
    return { hovered: describeTarget(element) };
  }

  function describeTarget(element) {
    if (element.querySelector?.(".xterm") || isTerminalElement(element)) return "terminal";
    return `${element.tagName.toLowerCase()} "${labelOf(element)}"`;
  }

  function setNativeValue(element, value) {
    const prototype =
      element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value").set.call(element, value);
  }

  function insertText(element, text) {
    if (!text) return;
    if (document.execCommand("insertText", false, text)) return;
    if (element.tagName === "INPUT" || element.tagName === "TEXTAREA") {
      const start = element.selectionStart ?? element.value.length;
      const end = element.selectionEnd ?? element.value.length;
      setNativeValue(element, element.value.slice(0, start) + text + element.value.slice(end));
    }
    element.dispatchEvent(
      new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: "insertText",
        data: text,
      }),
    );
  }

  function keyboardEvent(type, stroke) {
    const event = new KeyboardEvent(type, {
      key: stroke.key,
      code: stroke.code,
      ctrlKey: stroke.ctrlKey,
      metaKey: stroke.metaKey,
      altKey: stroke.altKey,
      shiftKey: stroke.shiftKey,
      bubbles: true,
      cancelable: true,
      composed: true,
      view: window,
    });
    // Constructors ignore the legacy codes, and xterm reads nothing else.
    for (const property of ["keyCode", "which"]) {
      Object.defineProperty(event, property, { get: () => stroke.keyCode });
    }
    return event;
  }

  function isPrintable(stroke) {
    return stroke.key.length === 1 && !stroke.ctrlKey && !stroke.metaKey && !stroke.altKey;
  }

  function tabbable() {
    return [...document.querySelectorAll(FOCUSABLE)].filter(
      (element) => element.tabIndex >= 0 && isVisible(element),
    );
  }

  function moveFocus(element, backwards) {
    const order = tabbable();
    const at = order.indexOf(element);
    order[(at + (backwards ? -1 : 1) + order.length) % order.length]?.focus();
  }

  // Default actions inside an editable field, keyed by the stroke's key.
  const EDITING_DEFAULTS = {
    Backspace: () => document.execCommand("delete"),
    Delete: () => document.execCommand("forwardDelete"),
    Enter: (element) =>
      element.tagName === "INPUT"
        ? element.form?.requestSubmit()
        : document.execCommand("insertLineBreak"),
  };

  function isSelectAll(stroke) {
    return stroke.key.toLowerCase() === "a" && (stroke.metaKey || stroke.ctrlKey);
  }

  // What the browser would have done had the keystroke been real and nobody
  // called preventDefault. Synthetic events carry no default action at all.
  function defaultAction(element, stroke) {
    const terminal = isTerminalElement(element);
    if (stroke.key === "Tab" && !terminal) return moveFocus(element, stroke.shiftKey);
    if (terminal || !isEditable(element)) {
      if (stroke.key === "Enter" && element.tagName === "BUTTON") element.click();
      return undefined;
    }
    if (isSelectAll(stroke)) return document.execCommand("selectAll");
    return EDITING_DEFAULTS[stroke.key]?.(element);
  }

  function keys(strokes) {
    const sent = [];
    for (const stroke of strokes) {
      const element = document.activeElement || document.body;
      if (isPrintable(stroke) && !stroke.shiftKey) {
        insertText(element, stroke.key);
      } else {
        const proceed = element.dispatchEvent(keyboardEvent("keydown", stroke));
        if (proceed) {
          if (isPrintable(stroke)) insertText(element, stroke.key);
          else defaultAction(element, stroke);
        }
        element.dispatchEvent(keyboardEvent("keyup", stroke));
      }
      sent.push(stroke.key);
    }
    return { sent, focused: focusedDescription() };
  }

  function typeInto(options) {
    if (hasTarget(options)) {
      click(options);
    }
    const element = document.activeElement;
    if (!element || element === document.body) {
      throw new Error("nothing is focused to type into; click the field (or the terminal) first");
    }
    const segments = String(options.text).replace(/\r\n?/g, "\n").split("\n");
    segments.forEach((segment, index) => {
      if (index > 0) keys([options.enter]);
      insertText(document.activeElement || element, segment);
    });
    return { typed: options.text.length, into: focusedDescription() };
  }

  function scrollableAncestor(element) {
    for (let node = element; node && node !== document.body; node = node.parentElement) {
      const style = getComputedStyle(node);
      const vertical =
        /(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight;
      const horizontal =
        /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth;
      if (vertical || horizontal) return node;
    }
    return document.scrollingElement;
  }

  const SCROLL_VECTORS = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] };

  function windowCentre() {
    const x = window.innerWidth / 2;
    const y = window.innerHeight / 2;
    const hit = document.elementFromPoint(x, y) || document.body;
    return { element: hit, x, y, target: hit };
  }

  function scroll(options) {
    const located = hasTarget(options) ? resolve(options) : windowCentre();
    const amount = (options.amount || 3) * 100;
    const [ux, uy] = SCROLL_VECTORS[options.direction] || SCROLL_VECTORS.down;
    const dx = ux * amount;
    const dy = uy * amount;
    const proceed = located.target.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        composed: true,
        view: window,
        clientX: located.x,
        clientY: located.y,
        deltaX: dx,
        deltaY: dy,
        deltaMode: 0,
      }),
    );
    // xterm consumes the wheel itself; everything else needs the default scroll.
    if (proceed && !isTerminalElement(located.target)) {
      scrollableAncestor(located.target)?.scrollBy({ left: dx, top: dy });
    }
    return { scrolled: describeTarget(located.element), direction: options.direction };
  }

  function select(options) {
    const { element } = resolve(options);
    if (element.tagName !== "SELECT") {
      throw new Error(
        "select works on native <select> only; click a custom dropdown and its option instead",
      );
    }
    const wanted = String(options.value).toLowerCase();
    const option = [...element.options].find(
      (candidate) =>
        candidate.value.toLowerCase() === wanted || candidate.label.toLowerCase() === wanted,
    );
    if (!option) throw new Error(`no option "${options.value}"`);
    element.value = option.value;
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
    return { selected: option.label };
  }

  function readTerminals(options) {
    return terminals(Boolean(options.full)).map(({ element: _element, ...rest }) => rest);
  }

  const OPS = {
    snapshot,
    click,
    hover,
    type: typeInto,
    keys: () => keys(command.strokes),
    scroll,
    select,
    terminals: readTerminals,
  };
  const op = OPS[command.op];
  if (!op) throw new Error(`unknown page op "${command.op}"`);
  return op(command);
})();

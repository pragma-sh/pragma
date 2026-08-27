//! Native browser tabs.
//!
//! Each browser tab is a real child [`tauri::Webview`] embedded in the main
//! window (Tauri's multiwebview API, behind the `unstable` feature) rather than
//! an iframe — only a native webview can run dev tools, clear its own cookies, and
//! load pages that forbid framing. The React side owns the chrome (tab strip +
//! toolbar) and renders a placeholder `<div>`; the native webview floats on top
//! of that div, kept in sync via [`browser_set_bounds`] / [`browser_set_visible`].
//!
//! Tauri already tracks webviews by label, so there is no custom registry here —
//! the label (`browser-{tabId}`) is the single source of truth. Page title and
//! URL changes are reported to the frontend via the [`META_EVENT`] event using
//! Tauri's native `on_document_title_changed` / `on_navigation` hooks, so we never
//! expose the IPC surface to arbitrary remote pages.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Condvar, Mutex, OnceLock};
use std::time::{Duration, Instant};

use base64::Engine;
use tauri::webview::{PageLoadEvent, WebviewBuilder};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Rect, Url, Webview, WebviewUrl,
    Window,
};
use tauri_plugin_dialog::DialogExt;

use crate::error::{AppError, AppResult};

/// Label of the main window the browser webviews are children of.
const MAIN_WINDOW_LABEL: &str = "main";
/// Event name carrying `{ tabId, title?, url? }` page metadata to the frontend.
const META_EVENT: &str = "browser-meta";
/// Event name carrying native page-load lifecycle updates to the frontend.
const LOAD_EVENT: &str = "browser-load";
/// Cancelled navigation used by the post-load probe to report `WebKit`'s blank error page.
const LOAD_CHECK_SENTINEL_SCHEME: &str = "pragma-load-check";
/// Event name emitted by a browser webview when the user interacts with its content.
const FOCUS_REQUEST_EVENT: &str = "browser-focus-request";
/// Event name emitted by a browser webview when the page-side handler sees
/// Cmd/Ctrl+F while it (not the React chrome) holds keyboard focus.
const FIND_REQUEST_EVENT: &str = "browser-find-request";
/// URL scheme the injected [`focus_script`] navigates to on Cmd/Ctrl+F, mirroring
/// [`FOCUS_SENTINEL_SCHEME`]'s ping-via-cancelled-navigation trick.
const FIND_SENTINEL_SCHEME: &str = "pragma-find";
/// URL scheme the injected [`focus_script`] navigates to when its page gains
/// focus. It is a one-way "this page was focused" ping back to Rust: the
/// navigation handler recognizes the scheme, reports focus to the frontend, and
/// cancels the navigation so the page never actually leaves. This reuses the
/// native navigation hook (like title/URL reporting) instead of exposing the IPC
/// surface to arbitrary remote pages — `window.__TAURI_INTERNALS__` is not
/// available on remote origins, so an IPC `emit` would silently no-op there.
const FOCUS_SENTINEL_SCHEME: &str = "pragma-focus";
/// URL scheme the eval wrapper navigates to with a serialized result. The
/// navigation hook cancels the load and delivers the payload to the waiting Rust
/// caller. This avoids exposing Tauri IPC to arbitrary remote pages.
const EVAL_SENTINEL_SCHEME: &str = "pragma-eval";
/// URL scheme the injected design-mode overlay navigates to when the user stages
/// a change, carrying the prompt plus the picked element's markup. Same
/// cancelled-navigation trick as the focus/find/eval pings.
const DESIGN_SENTINEL_SCHEME: &str = "pragma-design";
/// Event name carrying a staged design-mode change to the frontend.
const DESIGN_STAGE_EVENT: &str = "browser-design-stage";
const BROWSER_EVAL_TIMEOUT: Duration = Duration::from_secs(5);

type BrowserEvalResult = Result<serde_json::Value, String>;

#[derive(Default)]
struct BrowserEvalPending {
    results: Mutex<HashMap<String, BrowserEvalResult>>,
    notify: Condvar,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserEvalCallbackPayload {
    ok: bool,
    result: Option<serde_json::Value>,
    error: Option<String>,
}

static BROWSER_EVAL_PENDING: OnceLock<BrowserEvalPending> = OnceLock::new();

/// Active design-mode capability per browser tab. A page must present this
/// short-lived token while the native side still considers design mode enabled.
static DESIGN_SESSIONS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();

/// Page-focus ping reported to the frontend so split-pane focus can follow a
/// click into a native browser webview's content.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFocusRequest {
    tab_id: String,
}

/// Cmd/Ctrl+F ping reported to the frontend so the find bar opens even when
/// keyboard focus is inside the page rather than the React chrome.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserFindRequest {
    tab_id: String,
}

/// One design-mode change staged from the page: the user's prompt plus enough
/// markup context for an agent to locate the element in the project's source.
///
/// Deserialized from the page's payload (which has no `tabId`, hence the
/// default) and re-serialized to the frontend with the owning tab filled in.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct BrowserDesignStage {
    #[serde(default)]
    tab_id: String,
    /// What the user typed into the pill input.
    prompt: String,
    /// `outerHTML` of the picked element, truncated by the page script.
    html: String,
    /// CSS selector path to the picked element.
    selector: String,
    /// Tag/id/class chain of the element's ancestors, outermost first.
    ancestors: String,
    /// Path + query the element was picked on.
    route: String,
    /// Full page URL the element was picked on.
    url: String,
}

/// The app's resolved theme colors, forwarded to the in-page design overlay.
///
/// The overlay lives in the page being designed, which has no access to
/// Pragma's CSS variables, so the frontend reads them off its own document and
/// passes them through. Empty fields fall back to the overlay's own defaults.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DesignPalette {
    primary: String,
    primary_foreground: String,
    primary_hover: String,
    surface: String,
    surface_foreground: String,
    border: String,
    muted_foreground: String,
    ring: String,
    font_family: String,
}

/// Page metadata reported to the frontend as a browser webview navigates.
///
/// `title` and `url` are independently optional: a title change emits only the
/// title, a navigation emits only the URL. The frontend treats absent fields as
/// "unchanged".
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserMeta {
    tab_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    title: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    url: Option<String>,
}

#[derive(Clone, Copy, serde::Serialize)]
#[serde(rename_all = "lowercase")]
enum BrowserLoadStatus {
    Started,
    Finished,
    Failed,
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowserLoad {
    tab_id: String,
    status: BrowserLoadStatus,
    url: String,
}

/// Derives the child-webview label that hosts a given tab's page.
fn webview_label(tab_id: &str) -> String {
    format!("browser-{tab_id}")
}

pub(crate) fn has_webview(app: &AppHandle, tab_id: &str) -> bool {
    app.get_webview(&webview_label(tab_id)).is_some()
}

/// Injects a small script into every browser page so that interacting with the
/// native webview surface is forwarded to the React frontend, which can then move
/// split-pane focus to the correct pane.
///
/// The page signals focus by navigating to the [`FOCUS_SENTINEL_SCHEME`] URL,
/// which the navigation hook intercepts and cancels — this works on remote pages,
/// where the Tauri IPC bridge is intentionally absent. The ping fires once per
/// focus session (reset on blur) so normal clicks and link navigations are
/// untouched.
fn focus_script() -> String {
    format!(
        r"
(function() {{
  let signalled = false;
  function signal() {{
    if (signalled) return;
    signalled = true;
    // Cancelled navigation used as a focus ping; see FOCUS_SENTINEL_SCHEME (Rust).
    window.location.href = '{FOCUS_SENTINEL_SCHEME}:focus';
  }}
  window.addEventListener('focus', signal, true);
  window.addEventListener('pointerdown', signal, true);
  window.addEventListener('blur', function() {{ signalled = false; }}, true);

  // Forward Cmd/Ctrl+F to the React find bar instead of letting it fall
  // through to the page (or nothing); see FIND_SENTINEL_SCHEME (Rust).
  window.addEventListener('keydown', function(event) {{
    const isMac = navigator.platform.toUpperCase().includes('MAC');
    const modifierHeld = isMac ? event.metaKey : event.ctrlKey;
    if (event.key.toLowerCase() === 'f' && modifierHeld && !event.shiftKey && !event.altKey) {{
      event.preventDefault();
      window.location.href = '{FIND_SENTINEL_SCHEME}:request';
    }}
  }}, true);
}})();
"
    )
}

/// Placeholder replaced with [`DESIGN_SENTINEL_SCHEME`] in [`DESIGN_SCRIPT`].
///
/// The design script is long and brace-heavy, so it is a plain constant with a
/// token substitution rather than a `format!` template (which would need every
/// JS brace doubled).
const DESIGN_SCHEME_TOKEN: &str = "__PRAGMA_DESIGN_SCHEME__";

/// Design-mode overlay, injected into every browser page but inert until
/// `window.__pragmaDesign.setEnabled(true)` runs (see [`browser_design_set`]).
///
/// While enabled it highlights the element nearest the cursor, swallows page
/// clicks so picking an element never navigates, and shows a pill input whose
/// "+" stages the change back to Rust over [`DESIGN_SENTINEL_SCHEME`], presenting
/// a native-issued capability held only in this closure. The enabled flag is
/// mirrored into `sessionStorage` so design mode survives page reloads and
/// same-origin navigation, where this script re-runs from scratch.
const DESIGN_SCRIPT: &str = r"
(function() {
  const SCHEME = '__PRAGMA_DESIGN_SCHEME__';
  const STORAGE_KEY = 'pragma-design-mode';
  const PALETTE_KEY = 'pragma-design-palette';
  // How close (px) the cursor must be to a child's box to descend into it, so
  // hovering an element's padding still picks the visually nearest child.
  const PROXIMITY_PX = 12;
  const MAX_HTML = 4000;

  const state = {
    enabled: false,
    token: null,
    host: null,
    box: null,
    label: null,
    pill: null,
    input: null,
    selected: null,
    cursorStyle: null,
    palette: null,
  };

  function encodeUtf8Base64Url(value) {
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function readStoredFlag() {
    try {
      return window.sessionStorage.getItem(STORAGE_KEY) === '1';
    } catch (error) {
      return false;
    }
  }

  function writeStoredFlag(enabled) {
    try {
      if (enabled) {
        window.sessionStorage.setItem(STORAGE_KEY, '1');
      } else {
        window.sessionStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      // Storage unavailable (private mode, opaque origin): design mode simply
      // does not survive a reload.
    }
  }

  // Colors come from the app's own theme tokens, pushed in as `--pragma-*`
  // custom properties by applyPalette (the page has no access to Pragma's CSS
  // variables). The literals here are only the fallback for a missing palette,
  // and track DESIGN.md's `primary` blue and `popover` charcoal.
  const STYLES = [
    '.box {',
    '  position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;',
    '  border: 1px solid var(--pragma-ring, #3b76ec);',
    '  border-radius: 3px; box-sizing: border-box; will-change: transform, width, height;',
    '  transition: transform 120ms cubic-bezier(0.2,0.8,0.2,1),',
    '    width 120ms cubic-bezier(0.2,0.8,0.2,1),',
    '    height 120ms cubic-bezier(0.2,0.8,0.2,1), opacity 120ms linear;',
    '}',
    // The tint is its own layer: opacity on .box would fade the border too, and
    // tinting the theme color directly would need color-mix.
    '.fill {',
    '  position: absolute; inset: 0; border-radius: inherit;',
    '  background: var(--pragma-ring, #3b76ec); opacity: 0.14;',
    '}',
    '.box.visible { opacity: 1; }',
    '.box.selected { border-width: 2px; }',
    '.box.selected .fill { opacity: 0.22; }',
    '.label {',
    '  position: fixed; left: 0; top: 0; pointer-events: none; opacity: 0;',
    '  padding: 2px 6px; border-radius: 4px;',
    '  background: var(--pragma-primary, #3b76ec); color: var(--pragma-primary-fg, #fff);',
    '  font: 500 11px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap;',
    '  transition: transform 120ms cubic-bezier(0.2,0.8,0.2,1), opacity 120ms linear;',
    '}',
    '.label.visible { opacity: 1; }',
    '.pill {',
    '  position: fixed; left: 0; top: 0; display: none; align-items: center; gap: 6px;',
    '  pointer-events: auto; padding: 5px 5px 5px 14px; border-radius: 999px;',
    '  background: var(--pragma-surface, #1c1f24); color: var(--pragma-surface-fg, #f9fafb);',
    '  border: 1px solid var(--pragma-border, transparent);',
    '  box-shadow: 0 10px 30px rgba(0,0,0,0.35);',
    '  font: 400 13px/1.4 var(--pragma-font, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif);',
    '}',
    '.pill.open { display: flex; }',
    '.pill input {',
    '  all: unset; width: 260px; color: inherit; font: inherit;',
    '}',
    '.pill input::placeholder { color: var(--pragma-muted-fg, rgba(249,250,251,0.5)); }',
    '.pill button {',
    '  width: 26px; height: 26px; flex: none; border: 0; border-radius: 999px; cursor: pointer;',
    '  background: var(--pragma-primary, #3b76ec); color: var(--pragma-primary-fg, #fff);',
    '  font-family: inherit; font-size: 17px; font-weight: 600; line-height: 1;',
    '  display: flex; align-items: center; justify-content: center;',
    '}',
    '.pill button:hover { background: var(--pragma-primary-hover, #2b5fd9); }',
  ].join('\n');

  // Theme token -> the CSS custom property the styles above read.
  const PALETTE_VARS = {
    primary: '--pragma-primary',
    primaryForeground: '--pragma-primary-fg',
    primaryHover: '--pragma-primary-hover',
    surface: '--pragma-surface',
    surfaceForeground: '--pragma-surface-fg',
    border: '--pragma-border',
    mutedForeground: '--pragma-muted-fg',
    ring: '--pragma-ring',
    fontFamily: '--pragma-font',
  };

  function readStoredPalette() {
    try {
      const stored = window.sessionStorage.getItem(PALETTE_KEY);
      return stored ? JSON.parse(stored) : null;
    } catch (error) {
      return null;
    }
  }

  // Paints the overlay in the app's colors. Persisted alongside the enabled
  // flag so a reload comes back themed rather than in fallback colors.
  function applyPalette(palette) {
    if (palette) {
      state.palette = palette;
      try {
        window.sessionStorage.setItem(PALETTE_KEY, JSON.stringify(palette));
      } catch (error) {
        // Storage unavailable; the palette just does not survive a reload.
      }
    }
    if (!state.palette || !state.host) return;
    for (const token of Object.keys(PALETTE_VARS)) {
      const value = state.palette[token];
      if (value) state.host.style.setProperty(PALETTE_VARS[token], value);
    }
  }

  function buildOverlay() {
    const host = document.createElement('div');
    host.style.cssText =
      'position:fixed;inset:0;pointer-events:none;z-index:2147483647;border:0;margin:0;padding:0;';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;
    const box = document.createElement('div');
    box.className = 'box';
    const fill = document.createElement('div');
    fill.className = 'fill';
    box.append(fill);
    const label = document.createElement('div');
    label.className = 'label';
    const pill = document.createElement('div');
    pill.className = 'pill';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Describe the change';
    const add = document.createElement('button');
    add.type = 'button';
    add.textContent = '+';
    add.setAttribute('aria-label', 'Stage change');
    add.addEventListener('click', stage);
    input.addEventListener('keydown', function(event) {
      if (event.key === 'Enter') {
        event.preventDefault();
        stage();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        clearSelection();
      }
    });
    pill.append(input, add);
    root.append(style, box, label, pill);
    document.documentElement.append(host);
    state.host = host;
    state.box = box;
    state.label = label;
    state.pill = pill;
    state.input = input;
    applyPalette(null);
  }

  function ensureOverlay() {
    if (state.host && state.host.isConnected) return true;
    if (!document.documentElement) return false;
    buildOverlay();
    return true;
  }

  function rectDistance(rect, x, y) {
    const dx = Math.max(rect.left - x, 0, x - rect.right);
    const dy = Math.max(rect.top - y, 0, y - rect.bottom);
    return Math.hypot(dx, dy);
  }

  // The deepest element under the cursor, then refined outward-in: when the
  // cursor sits in a container's padding or gap, descend into whichever child
  // box it is closest to.
  function nearestElement(x, y) {
    let element = document.elementFromPoint(x, y);
    if (!element || element === state.host || element === document.documentElement) return null;
    for (;;) {
      let best = null;
      let bestDistance = PROXIMITY_PX;
      for (const child of element.children) {
        if (child === state.host) continue;
        const rect = child.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        const distance = rectDistance(rect, x, y);
        if (distance < bestDistance) {
          best = child;
          bestDistance = distance;
        }
      }
      if (!best) return element;
      element = best;
    }
  }

  function elementLabel(element) {
    const id = element.id ? '#' + element.id : '';
    const className =
      typeof element.className === 'string' && element.className.trim()
        ? '.' + element.className.trim().split(/\s+/).slice(0, 2).join('.')
        : '';
    return element.tagName.toLowerCase() + id + className;
  }

  function paint(element, selected) {
    const rect = element.getBoundingClientRect();
    state.box.classList.toggle('selected', selected);
    state.box.classList.add('visible');
    state.box.style.transform = 'translate(' + rect.left + 'px,' + rect.top + 'px)';
    state.box.style.width = rect.width + 'px';
    state.box.style.height = rect.height + 'px';
    state.label.textContent = elementLabel(element);
    state.label.classList.add('visible');
    const labelTop = rect.top > 20 ? rect.top - 20 : rect.bottom + 4;
    state.label.style.transform = 'translate(' + rect.left + 'px,' + labelTop + 'px)';
  }

  function hidePaint() {
    state.box.classList.remove('visible', 'selected');
    state.label.classList.remove('visible');
  }

  function placePill(element) {
    const rect = element.getBoundingClientRect();
    state.pill.classList.add('open');
    const size = state.pill.getBoundingClientRect();
    const maxLeft = Math.max(8, window.innerWidth - size.width - 8);
    const left = Math.min(Math.max(rect.left, 8), maxLeft);
    const below = rect.bottom + 8;
    const top =
      below + size.height + 8 <= window.innerHeight
        ? below
        : Math.max(8, rect.top - size.height - 8);
    state.pill.style.transform = 'translate(' + left + 'px,' + top + 'px)';
  }

  function cssPath(element) {
    const parts = [];
    let current = element;
    while (current && current.nodeType === 1 && current !== document.documentElement) {
      if (current.id) {
        parts.unshift('#' + CSS.escape(current.id));
        break;
      }
      const tag = current.tagName.toLowerCase();
      const parent = current.parentElement;
      if (!parent) {
        parts.unshift(tag);
        break;
      }
      const siblings = Array.from(parent.children).filter(function(sibling) {
        return sibling.tagName === current.tagName;
      });
      parts.unshift(
        siblings.length > 1 ? tag + ':nth-of-type(' + (siblings.indexOf(current) + 1) + ')' : tag,
      );
      current = parent;
    }
    return parts.join(' > ');
  }

  function ancestorPath(element) {
    const chain = [];
    let current = element.parentElement;
    while (current && current !== document.documentElement) {
      chain.unshift(elementLabel(current));
      current = current.parentElement;
    }
    return chain.join(' > ');
  }

  function stage() {
    const element = state.selected;
    if (!element) return;
    const prompt = state.input.value.trim();
    if (!prompt) {
      state.input.focus();
      return;
    }
    const payload = {
      prompt: prompt,
      html: element.outerHTML.slice(0, MAX_HTML),
      selector: cssPath(element),
      ancestors: ancestorPath(element),
      route: window.location.pathname + window.location.search,
      url: window.location.href,
    };
    if (!state.token) return;
    clearSelection();
    window.location.href =
      SCHEME + '://stage/' + encodeUtf8Base64Url(JSON.stringify(payload)) +
      '?token=' + encodeURIComponent(state.token);
  }

  function selectElement(element) {
    state.selected = element;
    paint(element, true);
    state.input.value = '';
    placePill(element);
    state.input.focus();
  }

  function clearSelection() {
    state.selected = null;
    state.input.value = '';
    state.pill.classList.remove('open');
    hidePaint();
  }

  function isOverlayEvent(event) {
    if (!state.host) return false;
    const path = typeof event.composedPath === 'function' ? event.composedPath() : [];
    return path.includes(state.host) || event.target === state.host;
  }

  function onPointerMove(event) {
    if (!state.enabled || state.selected || !ensureOverlay()) return;
    if (isOverlayEvent(event)) return;
    const element = nearestElement(event.clientX, event.clientY);
    if (element) {
      paint(element, false);
    } else {
      hidePaint();
    }
  }

  // Picking an element must never activate the page, so every pointer event
  // outside the overlay is swallowed while design mode is on.
  function onBlockedEvent(event) {
    if (!state.enabled || isOverlayEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
  }

  function onClick(event) {
    if (!state.enabled || isOverlayEvent(event) || !ensureOverlay()) return;
    event.preventDefault();
    event.stopPropagation();
    const element = nearestElement(event.clientX, event.clientY);
    if (element) selectElement(element);
  }

  function onKeyDown(event) {
    if (state.enabled && event.key === 'Escape' && state.selected) {
      event.preventDefault();
      clearSelection();
    }
  }

  function onViewportChange() {
    if (!state.enabled || !state.selected) return;
    paint(state.selected, true);
    placePill(state.selected);
  }

  function setEnabled(enabled, palette, token) {
    state.enabled = Boolean(enabled);
    state.token = state.enabled && typeof token === 'string' ? token : null;
    writeStoredFlag(state.enabled);
    if (palette) applyPalette(palette);
    if (!state.enabled) {
      if (state.host) clearSelection();
      if (state.cursorStyle) {
        state.cursorStyle.remove();
        state.cursorStyle = null;
      }
      return;
    }
    if (!ensureOverlay()) return;
    applyPalette(null);
    if (!state.cursorStyle && document.head) {
      const cursorStyle = document.createElement('style');
      cursorStyle.textContent = '*, *::before, *::after { cursor: crosshair !important; }';
      document.head.append(cursorStyle);
      state.cursorStyle = cursorStyle;
    }
  }

  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerdown', onBlockedEvent, true);
  window.addEventListener('mousedown', onBlockedEvent, true);
  window.addEventListener('mouseup', onBlockedEvent, true);
  window.addEventListener('click', onClick, true);
  window.addEventListener('dblclick', onBlockedEvent, true);
  window.addEventListener('contextmenu', onBlockedEvent, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange, true);

  Object.defineProperty(window, '__pragmaDesign', {
    value: Object.freeze({ setEnabled: setEnabled }),
    configurable: false,
    writable: false,
  });

  state.palette = readStoredPalette();

  if (readStoredFlag()) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', function() { setEnabled(true); });
    } else {
      setEnabled(true);
    }
  }
})();
";

/// The design-mode overlay script with the sentinel scheme substituted in.
fn design_script() -> String {
    DESIGN_SCRIPT.replace(DESIGN_SCHEME_TOKEN, DESIGN_SENTINEL_SCHEME)
}

/// Decodes a `pragma-design://stage/<base64url>` payload into a staged change.
fn browser_design_stage_payload(encoded: &str) -> Result<BrowserDesignStage, String> {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| format!("invalid design stage encoding: {error}"))?;
    let json =
        String::from_utf8(bytes).map_err(|error| format!("invalid design stage text: {error}"))?;
    serde_json::from_str(&json).map_err(|error| format!("invalid design stage payload: {error}"))
}

fn design_sessions() -> &'static Mutex<HashMap<String, String>> {
    DESIGN_SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_design_session(tab_id: &str, token: String) {
    if let Ok(mut sessions) = design_sessions().lock() {
        sessions.insert(tab_id.to_string(), token);
    }
}

fn clear_design_session(tab_id: &str) {
    if let Ok(mut sessions) = design_sessions().lock() {
        sessions.remove(tab_id);
    }
}

fn design_session_authorized(tab_id: &str, presented: Option<&str>) -> bool {
    let Some(presented) = presented else {
        return false;
    };
    let Ok(sessions) = design_sessions().lock() else {
        return false;
    };
    sessions
        .get(tab_id)
        .is_some_and(|expected| constant_time_eq(expected.as_bytes(), presented.as_bytes()))
}

fn constant_time_eq(expected: &[u8], actual: &[u8]) -> bool {
    if expected.len() != actual.len() {
        return false;
    }
    expected
        .iter()
        .zip(actual)
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

/// Handles a design-mode staging ping: decode the payload, tag it with the
/// owning tab, and forward it to the frontend.
fn receive_design_navigation(app: &AppHandle, tab_id: &str, url: &Url) {
    let token = url
        .query_pairs()
        .find_map(|(key, value)| (key == "token").then(|| value.into_owned()));
    if !design_session_authorized(tab_id, token.as_deref()) {
        log::debug!("unauthorized browser design stage ignored for tab {tab_id}");
        return;
    }
    match browser_design_stage_payload(url.path().trim_start_matches('/')) {
        Ok(mut stage) => {
            stage.tab_id = tab_id.to_string();
            let _ = app.emit(DESIGN_STAGE_EVENT, stage);
        }
        Err(error) => log::warn!("browser design stage ignored: {error}"),
    }
}

fn eval_pending() -> &'static BrowserEvalPending {
    BROWSER_EVAL_PENDING.get_or_init(BrowserEvalPending::default)
}

fn build_eval_callback_script(script: &str, request_id: &str) -> AppResult<String> {
    let script = serde_json::to_string(script)?;
    let request_id = serde_json::to_string(request_id)?;
    let scheme = serde_json::to_string(EVAL_SENTINEL_SCHEME)?;
    Ok(format!(
        r"
(async function() {{
  const requestId = {request_id};
  const scheme = {scheme};
  function encodeUtf8Base64Url(value) {{
    const bytes = new TextEncoder().encode(value);
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }}
  function send(payload) {{
    const encoded = encodeUtf8Base64Url(JSON.stringify(payload));
    window.location.href = `${{scheme}}://${{requestId}}/${{encoded}}`;
  }}
  try {{
    const result = await (0, eval)({script});
    send({{ ok: true, result: typeof result === 'undefined' ? null : result }});
  }} catch (error) {{
    const message = error && typeof error === 'object' && 'message' in error
      ? String(error.message)
      : String(error);
    try {{
      send({{ ok: false, error: message }});
    }} catch (serializeError) {{
      const serializeMessage = serializeError && typeof serializeError === 'object' && 'message' in serializeError
        ? String(serializeError.message)
        : String(serializeError);
      send({{ ok: false, error: `failed to serialize browser eval result: ${{serializeMessage}}` }});
    }}
  }}
}})();
"
    ))
}

fn browser_eval_callback_payload(encoded: &str) -> BrowserEvalResult {
    let bytes = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(encoded)
        .map_err(|error| format!("invalid browser eval callback encoding: {error}"))?;
    let json = String::from_utf8(bytes)
        .map_err(|error| format!("invalid browser eval callback text: {error}"))?;
    let payload: BrowserEvalCallbackPayload = serde_json::from_str(&json)
        .map_err(|error| format!("invalid browser eval callback payload: {error}"))?;
    if payload.ok {
        Ok(payload.result.unwrap_or(serde_json::Value::Null))
    } else {
        Err(payload
            .error
            .unwrap_or_else(|| "browser eval failed".to_string()))
    }
}

fn record_eval_result(request_id: String, result: BrowserEvalResult) {
    let pending = eval_pending();
    if let Ok(mut results) = pending.results.lock() {
        results.insert(request_id, result);
        pending.notify.notify_all();
    }
}

fn receive_eval_navigation(url: &Url) {
    let Some(request_id) = url.host_str() else {
        log::warn!("browser eval callback missing request id");
        return;
    };
    let encoded = url.path().trim_start_matches('/');
    if encoded.is_empty() {
        record_eval_result(
            request_id.to_string(),
            Err("browser eval callback missing payload".to_string()),
        );
        return;
    }
    record_eval_result(
        request_id.to_string(),
        browser_eval_callback_payload(encoded),
    );
}

fn wait_for_eval_result(request_id: &str) -> AppResult<serde_json::Value> {
    let pending = eval_pending();
    let mut results = pending.results.lock()?;
    let start = Instant::now();
    loop {
        if let Some(result) = results.remove(request_id) {
            return result.map_err(AppError::Browser);
        }
        let elapsed = start.elapsed();
        if elapsed >= BROWSER_EVAL_TIMEOUT {
            results.remove(request_id);
            return Err(AppError::Browser("browser eval timed out".to_string()));
        }
        let Some(remaining) = BROWSER_EVAL_TIMEOUT.checked_sub(elapsed) else {
            results.remove(request_id);
            return Err(AppError::Browser("browser eval timed out".to_string()));
        };
        let (guard, timeout) = pending.notify.wait_timeout(results, remaining)?;
        results = guard;
        if timeout.timed_out() && !results.contains_key(request_id) {
            results.remove(request_id);
            return Err(AppError::Browser("browser eval timed out".to_string()));
        }
    }
}

/// Returns the main window (the multiwebview host for all browser tabs).
fn main_window(app: &AppHandle) -> AppResult<Window> {
    app.get_window(MAIN_WINDOW_LABEL)
        .ok_or_else(|| AppError::Browser("main window is not available".to_string()))
}

/// Height of the window's outer frame, in logical pixels.
///
/// Tauri positions embedded child webviews relative to the window frame, but the
/// React placeholder's `getBoundingClientRect` is relative to the content
/// viewport, which sits below the title bar. The frontend recovers the title-bar
/// inset as `frameHeight - window.innerHeight` (both reliable; no screen
/// coordinates) and offsets the webview by it. macOS reports `inner_size`
/// identically to the frame, so this is the only place the real frame height is
/// available.
#[tauri::command]
pub fn browser_frame_height(app: tauri::AppHandle) -> AppResult<f64> {
    let window = main_window(&app)?;
    let scale = window.scale_factor().unwrap_or(1.0);
    Ok(f64::from(window.outer_size()?.height) / scale)
}

/// Looks up the live webview for a browser tab, erroring if it is gone.
fn require_webview(app: &AppHandle, tab_id: &str) -> AppResult<Webview> {
    app.get_webview(&webview_label(tab_id))
        .ok_or_else(|| AppError::Browser(format!("no browser webview for tab {tab_id}")))
}

/// Normalizes address-bar text into a URL, defaulting to `https://` when the
/// user omits a scheme (so typing `example.com` just works).
pub(crate) fn parse_url(input: &str) -> AppResult<Url> {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Err(AppError::Browser("empty url".to_string()));
    }
    let has_scheme = trimmed.contains("://");
    let candidate = if has_scheme {
        trimmed.to_string()
    } else {
        format!("https://{trimmed}")
    };
    let mut url = Url::parse(&candidate)
        .map_err(|error| AppError::Browser(format!("invalid url '{input}': {error}")))?;
    if !has_scheme && url.host_str().is_some_and(is_local_host) {
        url.set_scheme("http")
            .map_err(|()| AppError::Browser(format!("invalid url '{input}'")))?;
    }
    Ok(url)
}

fn is_local_host(host: &str) -> bool {
    let host = host.trim_matches(['[', ']']);
    host.eq_ignore_ascii_case("localhost")
        || host.to_ascii_lowercase().ends_with(".localhost")
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback() || ip.is_unspecified())
}

fn navigation_script(url: &Url) -> AppResult<String> {
    let url = serde_json::to_string(url.as_str())?;
    Ok(format!("window.location.assign({url});"))
}

const BLANK_PAGE_CHECK_SCRIPT: &str = r"
window.setTimeout(function() {
  const body = document.body;
  const blank = !body || (
    !document.title.trim() &&
    body.childElementCount === 0 &&
    !(body.textContent || '').trim()
  );
  if (blank) {
    window.location.href = 'pragma-load-check://failed?url=' + encodeURIComponent(window.location.href);
  }
}, 0);
";

#[cfg(test)]
mod tests {
    use base64::Engine;

    use super::{
        browser_design_stage_payload, browser_eval_callback_payload, build_eval_callback_script,
        clear_design_session, design_script, design_session_authorized, navigation_script,
        parse_url, set_design_session, BLANK_PAGE_CHECK_SCRIPT,
    };

    fn encoded_payload(json: &str) -> String {
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(json.as_bytes())
    }

    #[test]
    fn parse_url_defaults_to_https() {
        let url = parse_url("moveinready.casa").expect("url should parse");

        assert_eq!(url.as_str(), "https://moveinready.casa/");
    }

    #[test]
    fn parse_url_defaults_local_addresses_to_http() {
        for (input, expected) in [
            ("localhost:5173", "http://localhost:5173/"),
            ("app.localhost:3000", "http://app.localhost:3000/"),
            ("127.0.0.1:8080", "http://127.0.0.1:8080/"),
            ("[::1]:4000", "http://[::1]:4000/"),
        ] {
            let url = parse_url(input).expect("local url should parse");

            assert_eq!(url.as_str(), expected);
        }
    }

    #[test]
    fn parse_url_preserves_existing_scheme() {
        let url = parse_url("http://example.com/path").expect("url should parse");

        assert_eq!(url.as_str(), "http://example.com/path");
    }

    #[test]
    fn navigation_script_assigns_serialized_url() {
        let url = parse_url("https://example.com/a?query=hello world").expect("url should parse");
        let script = navigation_script(&url).expect("script should build");

        assert_eq!(
            script,
            r#"window.location.assign("https://example.com/a?query=hello%20world");"#
        );
    }

    #[test]
    fn blank_page_check_reports_native_error_pages() {
        assert!(BLANK_PAGE_CHECK_SCRIPT.contains("body.childElementCount === 0"));
        assert!(BLANK_PAGE_CHECK_SCRIPT.contains("pragma-load-check://failed"));
    }

    #[test]
    fn browser_eval_callback_decodes_result() {
        let encoded = encoded_payload(r#"{"ok":true,"result":{"answer":42}}"#);
        let value = browser_eval_callback_payload(&encoded).expect("payload should decode");

        assert_eq!(value["answer"], 42);
    }

    #[test]
    fn browser_eval_callback_decodes_error() {
        let encoded = encoded_payload(r#"{"ok":false,"error":"boom"}"#);
        let error = browser_eval_callback_payload(&encoded).expect_err("payload should fail");

        assert_eq!(error, "boom");
    }

    #[test]
    fn design_stage_payload_decodes_change() {
        let encoded = encoded_payload(
            r#"{"prompt":"make it blue","html":"<button>Go</button>","selector":"body > button","ancestors":"body","route":"/pricing","url":"http://localhost:5173/pricing"}"#,
        );
        let stage = browser_design_stage_payload(&encoded).expect("payload should decode");

        assert_eq!(stage.tab_id, "");
        assert_eq!(stage.prompt, "make it blue");
        assert_eq!(stage.route, "/pricing");
    }

    #[test]
    fn design_stage_payload_rejects_garbage() {
        browser_design_stage_payload("not-base64!!").expect_err("payload should fail");
    }

    #[test]
    fn design_script_substitutes_sentinel_scheme() {
        let script = design_script();

        assert!(script.contains("'pragma-design'"));
        assert!(script.contains("'?token=' + encodeURIComponent(state.token)"));
        assert!(!script.contains("__PRAGMA_DESIGN_SCHEME__"));
    }

    #[test]
    fn design_session_requires_current_tab_token() {
        let tab_id = uuid::Uuid::new_v4().to_string();
        set_design_session(&tab_id, "first-token".to_string());

        assert!(design_session_authorized(&tab_id, Some("first-token")));
        assert!(!design_session_authorized(&tab_id, Some("wrong-token")));
        assert!(!design_session_authorized(&tab_id, None));

        set_design_session(&tab_id, "rotated-token".to_string());
        assert!(!design_session_authorized(&tab_id, Some("first-token")));
        assert!(design_session_authorized(&tab_id, Some("rotated-token")));

        clear_design_session(&tab_id);
        assert!(!design_session_authorized(&tab_id, Some("rotated-token")));
    }

    #[test]
    fn eval_callback_script_embeds_script_as_json() {
        let script = build_eval_callback_script("'quoted' + \" value\"", "request-1")
            .expect("script should build");

        assert!(script.contains("pragma-eval"));
        assert!(script.contains(r#""'quoted' + \" value\""#));
    }
}

/// Emits page metadata to the frontend, ignoring the (benign) error when the
/// main webview has gone away during shutdown.
fn emit_meta(app: &AppHandle, meta: &BrowserMeta) {
    let _ = app.emit(META_EVENT, meta);
}

/// Creates the native browser webview for a tab at the given logical bounds.
///
/// Bounds are CSS pixels in the content coordinate space (the same as the React
/// placeholder's `getBoundingClientRect`); [`content_offset`] translates them into
/// the outer-frame space Tauri positions child webviews in. Re-creating an
/// existing tab just repositions it.
#[tauri::command]
pub fn browser_create(
    app: tauri::AppHandle,
    tab_id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    if app.get_webview(&webview_label(&tab_id)).is_some() {
        return browser_set_bounds(app, tab_id, x, y, width, height);
    }
    let window = main_window(&app)?;
    let start_url = parse_url(&url)?;
    let label = webview_label(&tab_id);

    let title_app = app.clone();
    let title_tab = tab_id.clone();
    let nav_app = app.clone();
    let nav_tab = tab_id.clone();
    let load_app = app.clone();
    let load_tab = tab_id.clone();

    let builder = WebviewBuilder::new(label, WebviewUrl::External(start_url))
        .initialization_script(format!("{}{}", focus_script(), design_script()))
        .on_page_load(move |webview, payload| {
            let status = match payload.event() {
                PageLoadEvent::Started => BrowserLoadStatus::Started,
                PageLoadEvent::Finished => {
                    let _ = webview.eval(BLANK_PAGE_CHECK_SCRIPT);
                    BrowserLoadStatus::Finished
                }
            };
            let _ = load_app.emit(
                LOAD_EVENT,
                BrowserLoad {
                    tab_id: load_tab.clone(),
                    status,
                    url: payload.url().to_string(),
                },
            );
        })
        .on_document_title_changed(move |_webview, title| {
            emit_meta(
                &title_app,
                &BrowserMeta {
                    tab_id: title_tab.clone(),
                    title: Some(title),
                    url: None,
                },
            );
        })
        .on_navigation(move |url| {
            if url.scheme() == LOAD_CHECK_SENTINEL_SCHEME {
                let failed_url = url
                    .query_pairs()
                    .find_map(|(key, value)| (key == "url").then(|| value.into_owned()))
                    .unwrap_or_default();
                let _ = nav_app.emit(
                    LOAD_EVENT,
                    BrowserLoad {
                        tab_id: nav_tab.clone(),
                        status: BrowserLoadStatus::Failed,
                        url: failed_url,
                    },
                );
                return false;
            }
            if url.scheme() == EVAL_SENTINEL_SCHEME {
                receive_eval_navigation(url);
                return false;
            }
            // A focus ping, not a real navigation: report it and cancel the load.
            if url.scheme() == FOCUS_SENTINEL_SCHEME {
                let _ = nav_app.emit(
                    FOCUS_REQUEST_EVENT,
                    BrowserFocusRequest {
                        tab_id: nav_tab.clone(),
                    },
                );
                return false;
            }
            // A design-mode staging ping, not a real navigation.
            if url.scheme() == DESIGN_SENTINEL_SCHEME {
                receive_design_navigation(&nav_app, &nav_tab, url);
                return false;
            }
            // A Cmd/Ctrl+F ping, not a real navigation: report it and cancel the load.
            if url.scheme() == FIND_SENTINEL_SCHEME {
                let _ = nav_app.emit(
                    FIND_REQUEST_EVENT,
                    BrowserFindRequest {
                        tab_id: nav_tab.clone(),
                    },
                );
                return false;
            }
            clear_design_session(&nav_tab);
            emit_meta(
                &nav_app,
                &BrowserMeta {
                    tab_id: nav_tab.clone(),
                    title: None,
                    url: Some(url.to_string()),
                },
            );
            true
        });

    window.add_child(
        builder,
        LogicalPosition::new(x, y),
        LogicalSize::new(width.max(0.0), height.max(0.0)),
    )?;
    Ok(())
}

/// Repositions/resizes a browser webview to track its React placeholder.
#[tauri::command]
pub fn browser_set_bounds(
    app: tauri::AppHandle,
    tab_id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        webview.set_bounds(Rect {
            position: LogicalPosition::new(x, y).into(),
            size: LogicalSize::new(width.max(0.0), height.max(0.0)).into(),
        })?;
    }
    Ok(())
}

/// Shows or hides a browser webview when its tab gains or loses focus.
#[tauri::command]
pub fn browser_set_visible(app: tauri::AppHandle, tab_id: String, visible: bool) -> AppResult<()> {
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        if visible {
            webview.show()?;
        } else {
            webview.hide()?;
        }
    }
    Ok(())
}

/// Moves keyboard focus to a browser webview when its pane is focused.
#[tauri::command]
pub fn browser_focus(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?
        .set_focus()
        .map_err(|error| AppError::Browser(format!("failed to focus browser: {error}")))?;
    Ok(())
}

/// Navigates a browser webview to a new URL (address-bar submit).
#[tauri::command]
pub fn browser_navigate(app: tauri::AppHandle, tab_id: String, url: String) -> AppResult<()> {
    let url = parse_url(&url)?;
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        webview.eval(navigation_script(&url)?)?;
    }
    Ok(())
}

/// Navigates back in the webview's session history.
#[tauri::command]
pub fn browser_back(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("history.back()")?;
    Ok(())
}

/// Navigates forward in the webview's session history.
#[tauri::command]
pub fn browser_forward(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("history.forward()")?;
    Ok(())
}

/// Reloads the current page.
#[tauri::command]
pub fn browser_reload(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.eval("location.reload()")?;
    Ok(())
}

/// Opens the native dev tools inspector for a browser webview.
///
/// Enabled in release builds too via the `devtools` Cargo feature; opens in a
/// separate inspector window.
#[tauri::command]
pub fn browser_devtools(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.open_devtools();
    Ok(())
}

/// Clears all browsing data (cookies + cache + storage) for a browser webview.
///
/// The native API clears these together; there is no reliable cross-platform
/// (macOS + Linux) split, so the UI exposes a single "Clear browsing data".
#[tauri::command]
pub fn browser_clear_data(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    require_webview(&app, &tab_id)?.clear_all_browsing_data()?;
    Ok(())
}

/// Opens the given URL in the user's default system browser.
#[tauri::command]
pub fn browser_open_external(url: String) -> AppResult<()> {
    let url = parse_url(&url)?;
    opener::open(url.as_str())
        .map_err(|error| AppError::Browser(format!("failed to open external browser: {error}")))
}

/// Destroys the native webview backing a browser tab.
#[tauri::command]
pub fn browser_close(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    clear_design_session(&tab_id);
    if let Some(webview) = app.get_webview(&webview_label(&tab_id)) {
        webview.close()?;
    }
    Ok(())
}

/// Runs JavaScript in a browser webview and returns its JSON-serializable result.
#[tauri::command]
pub fn browser_eval(
    app: tauri::AppHandle,
    tab_id: String,
    script: String,
) -> AppResult<serde_json::Value> {
    let request_id = uuid::Uuid::new_v4().to_string();
    let callback_script = build_eval_callback_script(&script, &request_id)?;
    require_webview(&app, &tab_id)?.eval(&callback_script)?;
    wait_for_eval_result(&request_id)
}

/// Turns the injected design-mode overlay on or off for a browser tab.
///
/// The overlay itself is always injected (see [`DESIGN_SCRIPT`]); this only
/// flips its enabled flag, which also persists it for the page's session so a
/// reload or in-page navigation keeps design mode on.
#[tauri::command]
pub fn browser_design_set(
    app: tauri::AppHandle,
    tab_id: String,
    enabled: bool,
    palette: Option<DesignPalette>,
) -> AppResult<()> {
    let webview = require_webview(&app, &tab_id)?;
    let palette = serde_json::to_string(&palette)?;
    let token = enabled.then(|| uuid::Uuid::new_v4().to_string());
    if let Some(token) = &token {
        set_design_session(&tab_id, token.clone());
    } else {
        clear_design_session(&tab_id);
    }
    let token_json = serde_json::to_string(&token)?;
    let enabled_json = if enabled { "true" } else { "false" };
    let result = webview.eval(format!(
        "window.__pragmaDesign && window.__pragmaDesign.setEnabled({enabled_json}, {palette}, {token_json});"
    ));
    if result.is_err() {
        clear_design_session(&tab_id);
    }
    result.map_err(Into::into)
}

/// Scrolls the page by deltas or to a top/bottom anchor.
#[tauri::command]
pub fn browser_scroll(
    app: tauri::AppHandle,
    tab_id: String,
    x: i64,
    y: i64,
    to: Option<String>,
) -> AppResult<()> {
    let script = match to.as_deref() {
        Some("top") => "window.scrollTo({ top: 0, left: window.scrollX, behavior: 'auto' });"
            .to_string(),
        Some("bottom") => "window.scrollTo({ top: document.documentElement.scrollHeight, left: window.scrollX, behavior: 'auto' });".to_string(),
        Some(other) => return Err(AppError::Browser(format!("unknown scroll anchor: {other}"))),
        None => format!("window.scrollBy({{ left: {x}, top: {y}, behavior: 'auto' }});"),
    };
    require_webview(&app, &tab_id)?.eval(&script)?;
    Ok(())
}

/// Focuses the first element matching a CSS selector inside the page.
#[tauri::command]
pub fn browser_focus_element(
    app: tauri::AppHandle,
    tab_id: String,
    selector: String,
) -> AppResult<()> {
    let script = selector_eval(&selector, "el.focus(); true")?;
    require_webview(&app, &tab_id)?.eval(&script)?;
    Ok(())
}

/// Clicks the first element matching a CSS selector inside the page.
#[tauri::command]
pub fn browser_click(app: tauri::AppHandle, tab_id: String, selector: String) -> AppResult<()> {
    let script = selector_eval(&selector, "el.click(); true")?;
    require_webview(&app, &tab_id)?.eval(&script)?;
    Ok(())
}

fn selector_eval(selector: &str, body: &str) -> AppResult<String> {
    let selector = serde_json::to_string(selector)?;
    Ok(format!(
        "(() => {{ const el = document.querySelector({selector}); if (!el) throw new Error('selector not found'); {body}; }})();"
    ))
}

/// Total matches and the 0-based index of the currently active one (`-1` when
/// there are no matches) for an in-page find.
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrowserFindResult {
    count: usize,
    index: i64,
}

fn parse_find_result(value: serde_json::Value) -> AppResult<BrowserFindResult> {
    serde_json::from_value(value)
        .map_err(|error| AppError::Browser(format!("invalid find result: {error}")))
}

/// Highlights every occurrence of `query` in the page and jumps to the first
/// match, replacing any highlighting from a previous search. Uses injected
/// `<mark>` wrapping rather than `window.find()` because the latter cannot
/// report a match count or index, which the find bar's "3/12" indicator needs.
fn build_find_set_script(query: &str, case_sensitive: bool) -> AppResult<String> {
    let query = serde_json::to_string(query)?;
    let case_sensitive = if case_sensitive { "true" } else { "false" };
    Ok(format!(
        r"
(function() {{
  const state = window.__pragmaFind || (window.__pragmaFind = {{ marks: [], index: -1 }});
  for (const mark of state.marks) {{
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }}
  state.marks = [];
  state.index = -1;
  const query = {query};
  const caseSensitive = {case_sensitive};
  if (!query) return {{ count: 0, index: -1 }};
  const needle = caseSensitive ? query : query.toLowerCase();
  function findFuzzyRanges(text, search) {{
    const haystack = caseSensitive ? text : text.toLowerCase();
    const ranges = [];
    let searchFrom = 0;
    while (searchFrom < haystack.length) {{
      let needleIndex = 0;
      let start = -1;
      let end = -1;
      for (let i = searchFrom; i < haystack.length && needleIndex < search.length; i += 1) {{
        if (haystack[i] === search[needleIndex]) {{
          if (start === -1) start = i;
          end = i;
          needleIndex += 1;
        }}
      }}
      if (needleIndex < search.length) break;
      ranges.push({{ from: start, to: end + 1 }});
      searchFrom = end + 1;
    }}
    return ranges;
  }}
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {{
    acceptNode(node) {{
      const tag = node.parentElement && node.parentElement.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'MARK') return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    }},
  }});
  const textNodes = [];
  let current;
  while ((current = walker.nextNode())) textNodes.push(current);
  for (const node of textNodes) {{
    const text = node.textContent || '';
    const fragments = [];
    let lastEnd = 0;
    const ranges = findFuzzyRanges(text, needle);
    for (const range of ranges) {{
      fragments.push(document.createTextNode(text.slice(lastEnd, range.from)));
      const mark = document.createElement('mark');
      mark.setAttribute('data-pragma-find', '1');
      mark.style.backgroundColor = '#f59e0b';
      mark.style.color = '#111827';
      mark.textContent = text.slice(range.from, range.to);
      fragments.push(mark);
      state.marks.push(mark);
      lastEnd = range.to;
    }}
    if (ranges.length > 0) {{
      fragments.push(document.createTextNode(text.slice(lastEnd)));
      const parent = node.parentNode;
      for (const fragment of fragments) parent.insertBefore(fragment, node);
      parent.removeChild(node);
    }}
  }}
  if (state.marks.length > 0) {{
    state.index = 0;
    state.marks[0].style.backgroundColor = '#fb923c';
    state.marks[0].scrollIntoView({{ block: 'center' }});
  }}
  return {{ count: state.marks.length, index: state.marks.length ? 0 : -1 }};
}})();
"
    ))
}

/// Moves to the next/previous match highlighted by a prior `browser_find_set`.
fn build_find_seek_script(forward: bool) -> &'static str {
    if forward {
        r"
(function() {
  const state = window.__pragmaFind;
  if (!state || state.marks.length === 0) return { count: 0, index: -1 };
  if (state.index >= 0) state.marks[state.index].style.backgroundColor = '#f59e0b';
  state.index = (state.index + 1) % state.marks.length;
  state.marks[state.index].style.backgroundColor = '#fb923c';
  state.marks[state.index].scrollIntoView({ block: 'center' });
  return { count: state.marks.length, index: state.index };
})();
"
    } else {
        r"
(function() {
  const state = window.__pragmaFind;
  if (!state || state.marks.length === 0) return { count: 0, index: -1 };
  if (state.index >= 0) state.marks[state.index].style.backgroundColor = '#f59e0b';
  state.index = (state.index - 1 + state.marks.length) % state.marks.length;
  state.marks[state.index].style.backgroundColor = '#fb923c';
  state.marks[state.index].scrollIntoView({ block: 'center' });
  return { count: state.marks.length, index: state.index };
})();
"
    }
}

const FIND_CLEAR_SCRIPT: &str = r"
(function() {
  const state = window.__pragmaFind;
  if (!state) return null;
  for (const mark of state.marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    parent.replaceChild(document.createTextNode(mark.textContent), mark);
    parent.normalize();
  }
  state.marks = [];
  state.index = -1;
  return null;
})();
";

/// Highlights every occurrence of `query` in the page and jumps to the first
/// match. See [`build_find_set_script`].
#[tauri::command]
pub fn browser_find_set(
    app: tauri::AppHandle,
    tab_id: String,
    query: String,
    case_sensitive: bool,
) -> AppResult<BrowserFindResult> {
    let script = build_find_set_script(&query, case_sensitive)?;
    parse_find_result(browser_eval(app, tab_id, script)?)
}

/// Moves to the next (`forward: true`) or previous match from the last
/// `browser_find_set` call.
#[tauri::command]
pub fn browser_find_seek(
    app: tauri::AppHandle,
    tab_id: String,
    forward: bool,
) -> AppResult<BrowserFindResult> {
    parse_find_result(browser_eval(
        app,
        tab_id,
        build_find_seek_script(forward).to_string(),
    )?)
}

/// Removes find highlighting from the page.
#[tauri::command]
pub fn browser_find_clear(app: tauri::AppHandle, tab_id: String) -> AppResult<()> {
    browser_eval(app, tab_id, FIND_CLEAR_SCRIPT.to_string())?;
    Ok(())
}

/// CLI-oriented tab screenshot. Unlike [`browser_screenshot`], which needs the
/// frontend's placeholder rect (there is no frontend in a brokered CLI
/// request), this computes the webview's on-screen bounds directly: the
/// window's desktop-relative top-left ([`Window::outer_position`]) plus the
/// webview's window-relative position ([`Webview::position`]), both already in
/// physical pixels. Saves straight to disk — no save dialog — defaulting to a
/// timestamped path under the system temp dir when `out` is omitted.
#[tauri::command]
pub fn browser_screenshot_tab(
    app: tauri::AppHandle,
    tab_id: String,
    out: Option<String>,
) -> AppResult<serde_json::Value> {
    let webview = require_webview(&app, &tab_id)?;
    let window_origin = main_window(&app)?.outer_position()?;
    let webview_position = webview.position()?;
    let webview_size = webview.size()?;

    let image = capture_region(
        f64::from(window_origin.x + webview_position.x),
        f64::from(window_origin.y + webview_position.y),
        f64::from(webview_size.width),
        f64::from(webview_size.height),
    )?;

    let path = out.map_or_else(default_screenshot_path, PathBuf::from);
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
    {
        std::fs::create_dir_all(parent)?;
    }
    image
        .save(&path)
        .map_err(|error| AppError::Browser(format!("failed to save screenshot: {error}")))?;

    Ok(serde_json::json!({ "path": path.display().to_string() }))
}

/// Default save location for a CLI-requested screenshot when `--out` is omitted.
fn default_screenshot_path() -> PathBuf {
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|elapsed| elapsed.as_millis())
        .unwrap_or_default();
    std::env::temp_dir().join(format!("pragma-screenshot-{timestamp}.png"))
}

/// Screenshots the page region and saves it via a native save dialog.
///
/// `x`/`y`/`width`/`height` are **physical screen pixels** of the page area
/// (the frontend computes them from the placeholder rect plus the window's screen
/// offset and device pixel ratio). Returns the saved path, or `None` if the user
/// cancelled the dialog.
#[tauri::command]
pub fn browser_screenshot(
    app: tauri::AppHandle,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> AppResult<Option<String>> {
    let image = capture_region(x, y, width, height)?;
    let Some(target) = app
        .dialog()
        .file()
        .set_file_name("pragma-screenshot.png")
        .add_filter("PNG image", &["png"])
        .blocking_save_file()
    else {
        return Ok(None);
    };
    let path = target
        .into_path()
        .map_err(|error| AppError::Browser(format!("invalid save path: {error}")))?;
    image
        .save(&path)
        .map_err(|error| AppError::Browser(format!("failed to save screenshot: {error}")))?;
    Ok(Some(path.display().to_string()))
}

/// Captures the page region and returns it as a `data:image/png;base64,...` URL.
///
/// Used to paint a still of the live page while an HTML overlay (dropdown,
/// popover) is open over a browser pane: the native webview composites above all
/// HTML and so must be hidden for the overlay to show, but swapping in this
/// snapshot keeps the pane looking unchanged. Coordinates are **physical screen
/// pixels** of the page area, same as [`browser_screenshot`]. The caller must
/// capture *before* hiding the webview, while the live page is still on screen.
#[tauri::command]
pub fn browser_snapshot(x: f64, y: f64, width: f64, height: f64) -> AppResult<String> {
    use base64::Engine;

    let image = capture_region(x, y, width, height)?;
    let mut png = std::io::Cursor::new(Vec::new());
    image
        .write_to(&mut png, xcap::image::ImageFormat::Png)
        .map_err(|error| AppError::Browser(format!("failed to encode snapshot: {error}")))?;
    let encoded = base64::engine::general_purpose::STANDARD.encode(png.into_inner());
    Ok(format!("data:image/png;base64,{encoded}"))
}

/// Maps an `xcap` capture error into our application error type.
fn xcap_err(error: xcap::XCapError) -> AppError {
    AppError::Browser(format!("screen capture failed: {error}"))
}

/// Captures a rectangle of physical screen pixels into an RGBA image by grabbing
/// the monitor that contains the region and cropping to it.
fn capture_region(x: f64, y: f64, width: f64, height: f64) -> AppResult<xcap::image::RgbaImage> {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let (x, y, width, height) = (
        x.round() as i32,
        y.round() as i32,
        width.round().max(1.0) as u32,
        height.round().max(1.0) as u32,
    );

    let monitors = xcap::Monitor::all().map_err(xcap_err)?;
    let mut chosen = None;
    for monitor in monitors {
        let mx = monitor.x().map_err(xcap_err)?;
        let my = monitor.y().map_err(xcap_err)?;
        #[allow(clippy::cast_possible_wrap)]
        let mw = monitor.width().map_err(xcap_err)? as i32;
        #[allow(clippy::cast_possible_wrap)]
        let mh = monitor.height().map_err(xcap_err)? as i32;
        if x >= mx && y >= my && x < mx + mw && y < my + mh {
            chosen = Some((monitor, mx, my));
            break;
        }
    }
    let (monitor, mx, my) =
        chosen.ok_or_else(|| AppError::Browser("page is not on any monitor".to_string()))?;

    let shot = monitor.capture_image().map_err(xcap_err)?;
    #[allow(clippy::cast_sign_loss)]
    let local_x = (x - mx) as u32;
    #[allow(clippy::cast_sign_loss)]
    let local_y = (y - my) as u32;
    let crop_w = width.min(shot.width().saturating_sub(local_x));
    let crop_h = height.min(shot.height().saturating_sub(local_y));

    Ok(xcap::image::imageops::crop_imm(&shot, local_x, local_y, crop_w, crop_h).to_image())
}

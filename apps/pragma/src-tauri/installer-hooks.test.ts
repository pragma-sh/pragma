import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(here, "tauri.conf.json"), "utf8")) as {
  bundle: {
    externalBin: string[];
    windows?: {
      nsis?: { installerHooks?: string };
      wix?: { fragmentPaths?: string[]; componentGroupRefs?: string[] };
    };
  };
};
const hooks = readFileSync(join(here, "installer-hooks.nsh"), "utf8");
const wix = readFileSync(join(here, "installer-close-apps.wxs"), "utf8");

/** Bare sidecar names (`pragma-server`) from the bundled `binaries/<name>` paths. */
const sidecarNames = config.bundle.externalBin.map((path) => path.split("/").at(-1) ?? path);

/**
 * Every image name listed in the hook file's `PragmaForEachSidecar` macro — the
 * one place the sidecars are enumerated, applied to both the "is anything
 * running" probe and the kills.
 */
const listedNames = [
  ...(/!macro PragmaForEachSidecar[^]*?!macroend/.exec(hooks)?.[0] ?? "").matchAll(
    /!insertmacro \$\{_ACTION\} "([^"]+)"/g,
  ),
].map((match) => match[1] as string);

/**
 * The `util:CloseApplication` elements, matched as whole tags rather than by
 * loose string search — the surrounding comments mention the same attributes.
 */
const closeElements = [...wix.matchAll(/<util:CloseApplication[^>]*?\/>/g)].map(
  (match) => match[0],
);

/** Every image name the WiX fragment terminates, in document order. */
const closedNames = closeElements.map((element) => /Target="([^"]+)"/.exec(element)?.[1] as string);

/** The `.exe` image name for each sidecar, which is what both installers match on. */
const sidecarImages = sidecarNames.map((name) => `${name}.exe`);

describe("nsis installer hooks", () => {
  it("is wired into the windows bundle config", () => {
    expect(config.bundle.windows?.nsis?.installerHooks).toBe("./installer-hooks.nsh");
  });

  /**
   * Windows locks a running executable's image, and the sidecars outlive the
   * app window on purpose. A sidecar the hook forgets is a sidecar the
   * installer cannot overwrite — it aborts with "Error opening file for
   * writing: …\AppData\Local\Pragma\<name>.exe" — and nothing surfaces that
   * until someone installs over a running app.
   */
  it("stops every bundled sidecar", () => {
    expect(listedNames.toSorted()).toEqual(sidecarImages.toSorted());
  });

  /**
   * The list feeds both the probe and the kills, so a name added to it is
   * covered by each without a second edit.
   */
  it("applies the sidecar list to both the probe and the kills", () => {
    expect(hooks).toContain("!insertmacro PragmaForEachSidecar NotePragmaSidecar");
    expect(hooks).toContain("!insertmacro PragmaForEachSidecar StopPragmaSidecar");
  });

  /**
   * With the window open Tauri's own prompt warns; with it closed nothing else
   * would, and replacing the server's binary ends the detached sessions it
   * holds. Silent and passive runs must never block on the dialog.
   */
  it("warns before killing a background server the app is not holding", () => {
    expect(hooks).toContain("MessageBox MB_OKCANCEL");
    expect(hooks).toContain("${AndIfNot} ${Silent}");
    expect(hooks).toContain("${AndIf} $PassiveMode != 1");
  });

  /**
   * `File` and `Delete` both run inside sections the pre-hooks precede; the
   * post-hooks run once the binaries are already in use again.
   */
  it("runs before files are written and before they are deleted", () => {
    expect(hooks).toContain("!macro NSIS_HOOK_PREINSTALL");
    expect(hooks).toContain("!macro NSIS_HOOK_PREUNINSTALL");
  });

  /**
   * The app respawns the server and gateway when it sees them exit, so killing
   * sidecars while it is still running just re-locks the files.
   */
  it("stops the main binary before the sidecars it would respawn", () => {
    const stopMainBinary = hooks.indexOf("!insertmacro CheckIfAppIsRunning");
    const stopSidecars = hooks.indexOf("!insertmacro PragmaForEachSidecar StopPragmaSidecar");
    expect(stopMainBinary).toBeGreaterThan(-1);
    expect(stopSidecars).toBeGreaterThan(-1);
    expect(stopMainBinary).toBeLessThan(stopSidecars);
  });
});

describe("wix close-applications fragment", () => {
  /**
   * A WiX fragment is dead weight unless something references it, and the
   * reference is what pulls the `util:CloseApplication` rows into the MSI. Both
   * halves are needed, and a rename on either side silently disarms the whole
   * fragment.
   */
  it("is wired into the windows bundle config", () => {
    expect(config.bundle.windows?.wix?.fragmentPaths).toContain("./installer-close-apps.wxs");
    expect(config.bundle.windows?.wix?.componentGroupRefs).toContain("PragmaCloseApplications");
    expect(wix).toContain('<ComponentGroup Id="PragmaCloseApplications" />');
  });

  /** The MSI locks the same files as the NSIS installer, just under Program Files. */
  it("terminates the app and every bundled sidecar", () => {
    expect(closedNames.toSorted()).toEqual(["pragma.exe", ...sidecarImages].toSorted());
  });

  /**
   * `WixCloseApplication` has no sequence column, so the deferred action works
   * in table order. The app has to come first or it respawns the server and
   * gateway it is listed alongside, re-locking their files.
   */
  it("terminates the app before the sidecars it would respawn", () => {
    expect(closedNames[0]).toBe("pragma.exe");
  });

  /**
   * Restart Manager cannot shut down a headless background process cleanly, so
   * without both of these the MSI ends at a reboot demand instead of an install.
   */
  it("terminates rather than demanding a reboot", () => {
    const missing = closeElements
      .filter(
        (element) =>
          !element.includes('TerminateProcess="0"') || !element.includes('RebootPrompt="no"'),
      )
      .map((element) => /Target="([^"]+)"/.exec(element)?.[1]);
    expect(missing).toEqual([]);
  });
});

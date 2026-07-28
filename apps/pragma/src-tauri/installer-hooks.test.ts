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
      wix?: { fragmentPaths?: string[] };
    };
  };
};
const hooks = readFileSync(join(here, "installer-hooks.nsh"), "utf8");

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

/** The `.exe` image name NSIS uses for each sidecar. */
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

describe("wix installer", () => {
  /**
   * `util:CloseApplication` matches every process with the requested executable
   * basename. An elevated per-machine MSI must instead leave process discovery
   * to Restart Manager, which identifies holders of installed files.
   */
  it("does not load basename-based process termination fragments", () => {
    expect(config.bundle.windows?.wix?.fragmentPaths ?? []).not.toContain(
      "./installer-close-apps.wxs",
    );
  });
});

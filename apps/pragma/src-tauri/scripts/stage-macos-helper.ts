/** Stage the native helper's own TCC identity for both dev and packaged builds. */
import { createHash, randomUUID } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  cpSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { constants } from "@pragma-sh/constants";

const tauriDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = resolve(tauriDir, "../../..");
const profile = process.argv.includes("--release") ? "release" : "debug";
const binary = join(root, "target", profile, constants.computer.helperName);
const bundleName = `${constants.computer.macHelperAppName}.app`;
const bundle = join(root, "target", profile, bundleName);
const executable = join(bundle, "Contents/MacOS", constants.computer.helperName);
const icon = join(root, "crates/pragma-computer/icons/icon.icns");
const bundledIcon = join(bundle, "Contents/Resources/icon.icns");
// Keep a successful dev identity across builds launched from other terminals.
// `*.local` is gitignored; an explicit environment value always takes priority.
const devIdentityFile = join(tauriDir, "dev-signing-identity.local");
const savedDevIdentity =
  profile === "debug" && existsSync(devIdentityFile)
    ? readFileSync(devIdentityFile, "utf8").trim()
    : undefined;
// An ad hoc signature is identified by its hash, so every rebuilt dev helper
// is a new app to macOS and loses its Accessibility and Screen Recording
// grants. `PRAGMA_DEV_SIGNING_IDENTITY` (a codesigning identity in the login
// keychain, e.g. "Apple Development: …") makes the grants follow the
// certificate instead, so they survive rebuilds.
const identity =
  profile === "release"
    ? process.env.APPLE_SIGNING_IDENTITY || "-"
    : process.env.PRAGMA_DEV_SIGNING_IDENTITY || savedDevIdentity || "-";
const xml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const infoPlist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${xml(constants.computer.macHelperBundleId)}</string>
<key>CFBundleName</key><string>${xml(constants.computer.macHelperAppName)}</string>
<key>CFBundleExecutable</key><string>${xml(constants.computer.helperName)}</string>
<key>CFBundleIconFile</key><string>icon.icns</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string><key>LSUIElement</key><true/>
</dict></plist>`;
const digest = createHash("sha256")
  .update(readFileSync(binary))
  .update(identity)
  .update(infoPlist)
  .update(readFileSync(icon))
  .digest("hex");
const stamp = join(root, "target", profile, ".pragma-computer-bundle.sha");
const command = (args: string[], { showStderr = false } = {}) => {
  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  // Never render arguments, and render subprocess output only when the caller
  // knows it carries no secret: `security` commands take passwords as arguments.
  if (result.exitCode !== 0) {
    const detail = showStderr ? `: ${result.stderr.toString().trim()}` : "";
    throw new Error(`${args[0]} failed while signing the computer-use helper${detail}`);
  }
  return result.stdout.toString();
};
// `codesign` resolves an identity only through the user keychain search list,
// even when `--keychain` names the file, so a keychain missing from the list
// fails with "no identity found". Tauri's own signer adds its keychain the same way.
const searchList = () =>
  command(["security", "list-keychains", "-d", "user"])
    .split("\n")
    .map((line) => line.trim().replace(/^"|"$/g, ""))
    .filter(Boolean);
if (
  !existsSync(executable) ||
  !existsSync(bundledIcon) ||
  !existsSync(stamp) ||
  readFileSync(stamp, "utf8").trim() !== digest
) {
  rmSync(bundle, { recursive: true, force: true });
  mkdirSync(dirname(executable), { recursive: true });
  mkdirSync(dirname(bundledIcon), { recursive: true });
  cpSync(binary, executable);
  cpSync(icon, bundledIcon);
  writeFileSync(join(bundle, "Contents/Info.plist"), infoPlist);
  const distribution = profile === "release" && identity !== "-";
  const certificate = distribution ? process.env.APPLE_CERTIFICATE : undefined;
  let temporary: string | undefined;
  let keychain: string | undefined;
  let originalSearchList: string[] | undefined;
  try {
    if (certificate) {
      temporary = mkdtempSync(join(tmpdir(), "pragma-helper-sign-"));
      const p12 = join(temporary, "certificate.p12");
      writeFileSync(p12, Buffer.from(certificate, "base64"), { mode: 0o600 });
      keychain = join(temporary, "signing.keychain-db");
      const password = randomUUID();
      command(["security", "create-keychain", "-p", password, keychain]);
      command(["security", "unlock-keychain", "-p", password, keychain]);
      command([
        "security",
        "import",
        p12,
        "-k",
        keychain,
        "-P",
        process.env.APPLE_CERTIFICATE_PASSWORD ?? "",
        "-T",
        "/usr/bin/codesign",
      ]);
      command([
        "security",
        "set-key-partition-list",
        "-S",
        "apple-tool:,apple:,codesign:",
        "-s",
        "-k",
        password,
        keychain,
      ]);
      originalSearchList = searchList();
      command(["security", "list-keychains", "-d", "user", "-s", ...originalSearchList, keychain]);
    }
    command(
      [
        "codesign",
        "--force",
        "--sign",
        identity,
        "--identifier",
        constants.computer.macHelperBundleId,
        ...(distribution ? ["--options", "runtime", "--timestamp"] : []),
        ...(keychain ? ["--keychain", keychain] : []),
        bundle,
      ],
      { showStderr: true },
    );
    command(["codesign", "--verify", "--strict", bundle], { showStderr: true });
    writeFileSync(stamp, digest);
  } finally {
    if (originalSearchList)
      Bun.spawnSync(["security", "list-keychains", "-d", "user", "-s", ...originalSearchList], {
        stdout: "pipe",
        stderr: "pipe",
      });
    if (keychain)
      Bun.spawnSync(["security", "delete-keychain", keychain], { stdout: "pipe", stderr: "pipe" });
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
if (profile === "debug" && identity !== "-") {
  writeFileSync(devIdentityFile, `${identity}\n`, { mode: 0o600 });
}
// Tauri's custom files are copied without recursive signing. The nested helper
// is signed here before Tauri signs and notarizes the enclosing application.
const staged = join(tauriDir, "binaries", bundleName);
rmSync(staged, { recursive: true, force: true });
cpSync(bundle, staged, { recursive: true });
console.log(`staged ${bundleName} (${profile})`);

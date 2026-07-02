import {
  PragmaClient,
  PragmaGatewayError,
  PragmaTransportError,
  hasPragmaEnvironment,
  reportCleared,
  reportStarted,
} from "../packages/sdk/src/index";

interface BunLike {
  argv: string[];
  env: Record<string, string | undefined>;
}

interface ProcessLike {
  cwd(): string;
  exit(code?: number): never;
}

const runtime = globalThis as typeof globalThis & { Bun?: BunLike; process?: ProcessLike };
const bun = runtime.Bun;
const processLike = runtime.process;

if (!bun || !processLike) {
  throw new Error("This smoke script must be run with Bun.");
}

const baseUrl = bun.env.PRAGMA_GATEWAY_URL;
const token = bun.env.PRAGMA_GATEWAY_TOKEN;

if (!baseUrl || !token) {
  console.error("Missing PRAGMA_GATEWAY_URL or PRAGMA_GATEWAY_TOKEN.");
  console.error("Example:");
  console.error(
    "  PRAGMA_GATEWAY_URL=http://127.0.0.1:49152 PRAGMA_GATEWAY_TOKEN=... bun scripts/gateway-sdk-smoke.ts",
  );
  processLike.exit(1);
}

const root = bun.argv[2] ?? processLike.cwd();
const path = bun.argv[3] ?? "package.json";
const client = new PragmaClient({ baseUrl, token });

try {
  console.log(`Gateway: ${baseUrl}`);
  console.log(`Root: ${root}`);

  const exists = await client.fs.pathExists({ root, path });
  console.log(`fs.pathExists(${JSON.stringify(path)}): ${exists}`);

  const entries = await client.fs.listDir({ root, path: "." });
  console.log("fs.listDir(.) first entries:");
  for (const entry of entries.slice(0, 5)) {
    console.log(`  - ${(entry.isDir ? "dir" : "file").padEnd(4)} ${entry.name}`);
  }

  const [result] = await client.exec.run({
    cwd: root,
    commands: ["printf 'hello from pragma gateway sdk'"],
    maxConcurrent: 1,
  });
  console.log("exec.run:");
  console.log(`  status: ${result?.status ?? "unknown"}`);
  console.log(`  stdout: ${JSON.stringify(result?.stdout ?? "")}`);

  if (hasPragmaEnvironment(bun.env)) {
    await reportStarted({ agent: "sdk-smoke", env: bun.env });
    await reportCleared({ agent: "sdk-smoke", env: bun.env });
    console.log("agent report: sent started + cleared for sdk-smoke");
  } else {
    console.log("agent report: skipped because PRAGMA_TAB_ID/PRAGMA_WORKTREE_ID are not set");
  }

  console.log("Smoke test passed.");
} catch (error) {
  if (error instanceof PragmaGatewayError) {
    console.error(`Gateway error ${error.httpStatus} ${error.code}: ${error.message}`);
  } else if (error instanceof PragmaTransportError) {
    console.error(`Transport error: ${error.message}`);
  } else {
    console.error(error);
  }
  processLike.exit(1);
}

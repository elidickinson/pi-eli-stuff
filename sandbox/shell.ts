#!/usr/bin/env node --experimental-strip-types --no-warnings
// Boot a Gondolin VM with an interactive bash shell (instead of pi).
// Same env injection as index.ts (OAuth token, API keys) via shared env.ts.
// Usage: ./shell.ts [mount-dir] [-- extra gondolin args...]

import { execFileSync } from "node:child_process";
import path from "node:path";
import { buildVmEnv } from "./env.ts";

const guestImage = path.join(import.meta.dirname!, "guest-image");
const mountDir = process.argv[2] || process.cwd();

const vmEnv = buildVmEnv();
const envArgs = Object.entries(vmEnv).flatMap(([k, v]) => ["--env", `${k}=${v}`]);

for (const key of Object.keys(vmEnv)) {
  console.log(key === "CLAUDE_CODE_OAUTH_TOKEN" ? "Claude OAuth token injected." : `Forwarding ${key}`);
}

execFileSync("gondolin", [
  "bash",
  "--mount-hostfs", `${mountDir}:/workspace`,
  "--cwd", "/workspace",
  ...envArgs,
  ...process.argv.slice(3),
], {
  stdio: "inherit",
  env: { ...process.env, GONDOLIN_GUEST_DIR: guestImage },
});

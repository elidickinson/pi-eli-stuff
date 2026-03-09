/**
 * Pi + Gondolin Sandbox
 *
 * Runs pi tools inside a Gondolin micro-VM.
 *
 * Usage:
 *   cd /path/to/your/project
 *   pi -e /path/to/pi-sandbox.ts
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { buildVmEnv } from "./env.ts";
import {
  type BashOperations,
  createBashTool,
  createEditTool,
  createReadTool,
  createWriteTool,
  type EditOperations,
  type ReadOperations,
  type WriteOperations,
} from "@mariozechner/pi-coding-agent";

import { RealFSProvider, VM, type VMOptions } from "@earendil-works/gondolin";

const GUEST_WORKSPACE = "/workspace";
const GUEST_CONFIG = "/config";
const HOST_CONFIG = path.join(os.homedir(), ".config", "pi-sandbox");

function readCachedFile(name: string): string | null {
  try {
    const t = fs.readFileSync(path.join(HOST_CONFIG, name), "utf-8").trim();
    return t || null;
  } catch { return null; }
}

function vmCreateOptions(localCwd: string): VMOptions {
  const vmEnv = buildVmEnv();
  const token = readCachedFile("claude-code-token");
  if (token) vmEnv.CLAUDE_CODE_OAUTH_TOKEN = token;
  vmEnv.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "true";
  vmEnv.DISABLE_INSTALLATION_CHECKS = "1";
  const imagePath = process.env.GONDOLIN_GUEST_DIR;
  return {
    sandbox: imagePath ? { imagePath } : undefined,
    env: Object.keys(vmEnv).length > 0 ? vmEnv : undefined,
    vfs: {
      mounts: {
        [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
        [GUEST_CONFIG]: new RealFSProvider(HOST_CONFIG),
      },
    },
    dns: { mode: "synthetic", syntheticHostMapping: "per-host" },
    tcp: { hosts: { "sbrowser.sidget.net:443": "sbrowser.sidget.net:443" } },
  };
}

/** Write Claude Code config files in the guest to skip onboarding/login/trust. */
async function writeClaudeConfig(vm: VM): Promise<void> {
  const claudeJson: Record<string, unknown> = {
    hasCompletedOnboarding: true,
    theme: "dark",
    numStartups: 1,
    lastOnboardingVersion: "2.1.71",
    installMethod: "global",
    projects: { [GUEST_WORKSPACE]: { hasTrustDialogAccepted: true } },
  };
  const account = readCachedFile("claude-code-account.json");
  if (account) claudeJson.oauthAccount = JSON.parse(account);
  await vm.fs.writeFile("/root/.claude.json", Buffer.from(JSON.stringify(claudeJson)));

  const settings = { attribution: { commit: "", pr: "" } };
  await vm.fs.mkdir("/root/.claude", { recursive: true });
  await vm.fs.writeFile("/root/.claude/settings.json", Buffer.from(JSON.stringify(settings)));
}

function shQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function toGuestPath(localCwd: string, localPath: string): string {
  if (path.isAbsolute(localPath)) {
    // If path is already in guest workspace format (e.g., from recursive tool calls or
    // paths previously converted), normalize and validate before returning.
    if (localPath.startsWith(GUEST_WORKSPACE + path.posix.sep) || localPath === GUEST_WORKSPACE) {
      const normalized = path.posix.normalize(localPath);
      if (!normalized.startsWith(GUEST_WORKSPACE)) {
        throw new Error(`path escapes workspace: ${localPath}`);
      }
      return normalized;
    }

    // Absolute path (host format): must be within localCwd
    const rel = path.relative(localCwd, localPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${localPath}`);
    }
    if (rel === "") return GUEST_WORKSPACE;
    const posixRel = rel.split(path.sep).join(path.posix.sep);
    return path.posix.join(GUEST_WORKSPACE, posixRel);
  } else {
    // Relative path: resolve against localCwd
    const absPath = path.resolve(localCwd, localPath);
    const rel = path.relative(localCwd, absPath);
    if (rel.startsWith("..") || path.isAbsolute(rel)) {
      throw new Error(`path escapes workspace: ${absPath}`);
    }
    if (rel === "") return GUEST_WORKSPACE;
    const posixRel = rel.split(path.sep).join(path.posix.sep);
    return path.posix.join(GUEST_WORKSPACE, posixRel);
  }
}

function createGondolinReadOps(vm: VM, localCwd: string): ReadOperations {
  return {
    readFile: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      return vm.fs.readFile(guestPath);
    },
    access: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      await vm.fs.access(guestPath);
    },
    detectImageMimeType: async (p) => {
      const guestPath = toGuestPath(localCwd, p);
      try {
        const r = await vm.exec([
          "/bin/sh",
          "-lc",
          `file --mime-type -b ${shQuote(guestPath)}`,
        ]);
        if (!r.ok) return null;
        const m = r.stdout.trim();
        return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(
          m,
        )
          ? m
          : null;
      } catch {
        return null;
      }
    },
  };
}

function createGondolinWriteOps(vm: VM, localCwd: string): WriteOperations {
  return {
    writeFile: async (p, content) => {
      const guestPath = toGuestPath(localCwd, p);
      const dir = path.posix.dirname(guestPath);
      await vm.fs.mkdir(dir, { recursive: true });
      await vm.fs.writeFile(guestPath, content);
    },
    mkdir: async (dir) => {
      const guestDir = toGuestPath(localCwd, dir);
      await vm.fs.mkdir(guestDir, { recursive: true });
    },
  };
}

function createGondolinEditOps(vm: VM, localCwd: string): EditOperations {
  const r = createGondolinReadOps(vm, localCwd);
  const w = createGondolinWriteOps(vm, localCwd);
  return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function sanitizeEnv(
  env?: NodeJS.ProcessEnv,
): Record<string, string> | undefined {
  if (!env) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (typeof v === "string") out[k] = v;
  }
  return out;
}

function createGondolinBashOps(vm: VM, localCwd: string): BashOperations {
  return {
    exec: async (command, cwd, { onData, signal, timeout, env }) => {
      const guestCwd = toGuestPath(localCwd, cwd);

      const ac = new AbortController();
      const onAbort = () => ac.abort();
      signal?.addEventListener("abort", onAbort, { once: true });

      let timedOut = false;
      const timer =
        timeout && timeout > 0
          ? setTimeout(() => {
              timedOut = true;
              ac.abort();
            }, timeout * 1000)
          : undefined;

      try {
        const proc = vm.exec(["/bin/bash", "-lc", command], {
          cwd: guestCwd,
          signal: ac.signal,
          env: sanitizeEnv(env),
          stdout: "pipe",
          stderr: "pipe",
        });

        for await (const chunk of proc.output()) {
          onData(chunk.data);
        }

        const r = await proc;
        return { exitCode: r.exitCode };
      } catch (err) {
        if (signal?.aborted) throw new Error("aborted");
        if (timedOut) throw new Error(`timeout:${timeout}`);
        throw err;
      } finally {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}

export default function (pi: ExtensionAPI) {
  const localCwd = process.cwd();

  const localRead = createReadTool(localCwd);
  const localWrite = createWriteTool(localCwd);
  const localEdit = createEditTool(localCwd);
  const localBash = createBashTool(localCwd);

  let vm: VM | null = null;
  let vmStarting: Promise<VM> | null = null;

  async function closeVm(ctx?: ExtensionContext) {
    if (!vm) return;
    const instance = vm;
    vm = null;
    vmStarting = null;
    ctx?.ui?.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );

    let timer: ReturnType<typeof setTimeout> | undefined;

    try {
      await Promise.race([
        instance.close(),
        new Promise<void>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timeout")), 3000);
        }),
      ]);
    } catch (err) {
      if ((err as Error).message === "timeout") {
        ctx?.ui?.notify("Gondolin VM shutdown timed out", "warn");
      } else {
        throw err;
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function ensureVm(ctx?: ExtensionContext) {
    if (vm) return vm;
    if (vmStarting) return vmStarting;

    vmStarting = (async () => {
      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: starting (mount ${GUEST_WORKSPACE})`,
        ),
      );

      fs.mkdirSync(HOST_CONFIG, { recursive: true });

      const created = await VM.create(vmCreateOptions(localCwd));
      try { await writeClaudeConfig(created); } catch {}

      vm = created;

      let buildInfo = "";
      try {
        const r = await created.exec("cat /etc/build-info");
        if (r.exitCode === 0) buildInfo = r.stdout.trim();
      } catch {}

      ctx?.ui.setStatus(
        "gondolin",
        ctx.ui.theme.fg(
          "accent",
          `Gondolin: running (${localCwd} -> ${GUEST_WORKSPACE})`,
        ),
      );
      ctx?.ui.notify(
        `Gondolin VM ready. Host ${localCwd} mounted at ${GUEST_WORKSPACE}` +
          (buildInfo ? `\n${buildInfo}` : "\nWarning: no /etc/build-info in guest image"),
        "info",
      );
      return created;
    })();

    return vmStarting;
  }

  pi.on("session_start", async (_event, ctx) => {
    await ensureVm(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await closeVm(ctx);
  });

  pi.registerTool({
    ...localRead,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createReadTool(localCwd, {
        operations: createGondolinReadOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localWrite,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createWriteTool(localCwd, {
        operations: createGondolinWriteOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localEdit,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createEditTool(localCwd, {
        operations: createGondolinEditOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  pi.registerTool({
    ...localBash,
    async execute(id, params, signal, onUpdate, ctx) {
      const activeVm = await ensureVm(ctx);
      const tool = createBashTool(localCwd, {
        operations: createGondolinBashOps(activeVm, localCwd),
      });
      return tool.execute(id, params, signal, onUpdate);
    },
  });

  // host_bash: escape hatch for commands that must run on the host (not in the VM).
  // Every invocation requires explicit user approval via a confirm dialog.
  pi.registerTool({
    name: "host_bash",
    label: "Host Bash",
    description:
      "Execute a command on the host machine (outside the sandbox VM). " +
      "Requires user approval. Use only when the command cannot run inside the VM " +
      "(e.g., package managers, macOS services, system tools).",
    parameters: Type.Object({
      command: Type.String({ description: "The bash command to execute on the host" }),
      reason: Type.String({
        description: "One sentence explaining why this must run on the host instead of in the sandbox VM",
      }),
      timeout: Type.Optional(
        Type.Number({ description: "Timeout in seconds (default: 30)" }),
      ),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      if (!ctx.hasUI) {
        return {
          content: [{ type: "text", text: "Host execution is not available in non-interactive mode." }],
          details: {},
        };
      }

      // Log the full command in chat history before the confirm dialog
      ctx.ui.notify(`[host_bash] $ ${params.command}\nReason: ${params.reason}`, "info");

      const displayCmd = params.command.length > 200
        ? params.command.slice(0, 200) + `... (${params.command.length} chars total)`
        : params.command;
      const confirmed = await ctx.ui.confirm(
        "Host execution requested",
        `$ ${displayCmd}\n\nReason: ${params.reason}`,
      );

      if (!confirmed) {
        return {
          content: [{ type: "text", text: "User denied host execution." }],
          details: {},
        };
      }

      // Run on host using the local (non-sandboxed) bash tool
      return localBash.execute(
        _id,
        { command: params.command, timeout: params.timeout ?? 30 },
        signal,
        _onUpdate,
      );
    },
  });

  pi.on("user_bash", (_event) => {
    if (!vm) return;
    return { operations: createGondolinBashOps(vm, localCwd) };
  });

  pi.on("before_agent_start", async (event, ctx) => {
    await ensureVm(ctx);
    const modified = event.systemPrompt.replace(
      `Current working directory: ${localCwd}`,
      `Current working directory: ${GUEST_WORKSPACE} (Gondolin VM, mounted from host: ${localCwd})`,
    );
    const appendix = `
## Your Sandbox Environment

Tools available via bash: rg (ripgrep), git, gh (github), curl, python3, node

All paths are automatically translated between host and guest. Paths cannot escape the workspace.

**Executing workspace binaries:** Use \`uv run python -m <command>\` (FUSE restrictions). \`uv run pytest\` doesn't work - use \`uv run python -m pytest\` instead of \`.venv-sandbox/bin/pytest\`.

**Host access:** Use the \`host_bash\` tool when you need to run commands on the host machine (package managers, system tools, macOS services). You must provide a one-sentence reason. Each command requires user approval.
`;
    return { systemPrompt: modified + appendix };
  });
}

// When run directly (not imported as extension): interactive shell
const isDirectRun = import.meta.filename === process.argv[1];
if (isDirectRun) {
  const cwd = process.argv[2] || process.cwd();
  fs.mkdirSync(HOST_CONFIG, { recursive: true });
  const vm = await VM.create(vmCreateOptions(cwd));
  try { await writeClaudeConfig(vm); } catch {}
  const proc = vm.shell({ attach: true, cwd: GUEST_WORKSPACE });
  const result = await proc;
  await vm.close();
  process.exit(result.exitCode);
}

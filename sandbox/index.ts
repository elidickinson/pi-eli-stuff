/**
 * Pi + Gondolin Sandbox
 *
 * Runs pi tools inside a Gondolin micro-VM.
 *
 * Usage:
 *   cd /path/to/your/project
 *   pi -e /path/to/pi-sandbox.ts
 */

import path from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

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

import { RealFSProvider, VM } from "@earendil-works/gondolin";

const GUEST_WORKSPACE = "/workspace";

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

      const vmEnv = buildVmEnv();

      const imagePath = process.env.GONDOLIN_GUEST_DIR;
      const created = await VM.create({
        sandbox: imagePath ? { imagePath } : undefined,
        env: Object.keys(vmEnv).length > 0 ? vmEnv : undefined,
        vfs: {
          mounts: {
            [GUEST_WORKSPACE]: new RealFSProvider(localCwd),
          },
        },
      });

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
    if (!vm) return;
    ctx.ui.setStatus(
      "gondolin",
      ctx.ui.theme.fg("muted", "Gondolin: stopping"),
    );
    try {
      await vm.close();
    } finally {
      vm = null;
      vmStarting = null;
    }
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
    const appendix = "\nTools available via bash: rg (ripgrep), git, gh (github), curl, python3, node";
    return { systemPrompt: modified + appendix };
  });
}

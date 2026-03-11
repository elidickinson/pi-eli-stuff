import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AcpxResult {
  text: string;
  exitCode: number | undefined;
  executionTime: number;
}

interface SpawnAcpxOptions {
  args: string[];
  prompt: string;
  signal?: AbortSignal;
  onStdout?: (accumulated: string) => void;
}

/** Spawn acpx with args, pipe prompt via stdin, collect output. */
function spawnAcpx(opts: SpawnAcpxOptions): Promise<AcpxResult> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn("acpx", opts.args, {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk;
      opts.onStdout?.(stdout);
    });
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    const onAbort = () => proc.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      opts.signal?.removeEventListener("abort", onAbort);
      if (opts.signal?.aborted) return reject(new Error("aborted"));
      resolve({
        text: stdout.trim() || stderr.trim() || `(exit ${code})`,
        exitCode: code ?? undefined,
        executionTime: Date.now() - startTime,
      });
    });
    proc.on("error", reject);

    proc.stdin.write(opts.prompt);
    proc.stdin.end();
  });
}

/** Ensure a named session exists, with timeout. */
function ensureSession(name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      proc.kill();
      reject(new Error("sessions ensure timed out"));
    }, 10000);

    const proc = spawn("acpx", ["claude", "sessions", "ensure", "--name", name], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: process.cwd(),
    });
    let stderr = "";
    proc.stderr?.on("data", (c: Buffer) => (stderr += c));
    proc.on("close", (code) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(stderr || `sessions ensure failed with code ${code}`));
    });
    proc.on("error", (e) => {
      clearTimeout(timeout);
      reject(e);
    });
  });
}

// --- Render helpers ---

type Theme = Parameters<NonNullable<Parameters<ExtensionAPI["registerTool"]>[0]["renderResult"]>>[2];

function statusText(theme: Theme, exitCode: number | undefined, label: string, responseText?: string): string {
  const isError = exitCode != null && exitCode !== 0;
  if (!isError) return theme.fg("success", `✓ ${label}`);
  let text = theme.fg("error", `✗ ${label} (exit ${exitCode})`);
  if (responseText) {
    text += ` ${theme.fg("muted", firstLinePreview(responseText, 120))}`;
  }
  return text;
}

function firstLinePreview(text: string, maxLen = 150): string {
  const line = text.split("\n")[0] || "";
  return line.length > maxLen ? line.substring(0, maxLen) + "..." : line;
}

// --- Extension ---

interface ClaudeAcpDetails {
  session_name?: string;
  prompt: string;
  promptLength: number;
  executionTime: number;
  exitCode?: number;
}

export default function (pi: ExtensionAPI) {
  // /claude slash command — inline one-shot, result stays in context
  const CLAUDE_MSG_TYPE = "claude-acp-response";

  pi.registerMessageRenderer(CLAUDE_MSG_TYPE, (message, { expanded }, theme) => {
    const details = message.details as { prompt?: string; executionTime: number; exitCode?: number } | undefined;
    const content = typeof message.content === "string" ? message.content : message.content[0]?.text || "";
    let text = "";
    if (details?.prompt) text += theme.fg("accent", "/claude ") + details.prompt + "\n\n";
    text += statusText(theme, details?.exitCode, "Claude", content);
    if (details?.executionTime) {
      text += theme.fg("dim", ` ${(details.executionTime / 1000).toFixed(1)}s`);
    }
    if (content) text += `\n\n${content}`;
    return new Text(text, 0, 0);
  });

  pi.registerCommand("claude", {
    description: "Ask Claude a quick question (one-shot, result stays in context)",
    async handler(args, ctx) {
      const prompt = args.trim();
      if (!prompt) {
        ctx.ui.notify("Usage: /claude <question>", "warning");
        return;
      }
      ctx.ui.notify("⟳ Asking Claude...", "info");
      const result = await spawnAcpx({
        args: ["--format", "quiet", "--approve-reads", "claude", "exec", "--file", "-"],
        prompt,
      });
      pi.sendMessage(
        {
          customType: CLAUDE_MSG_TYPE,
          content: result.text,
          display: true,
          details: { prompt, executionTime: result.executionTime, exitCode: result.exitCode },
        },
        { triggerTurn: false },
      );
    },
  });

  pi.registerTool({
    name: "ClaudeAcp",
    label: "Claude ACP",
    description: "Send a prompt to Claude Code via ACP. Sessions persist conversation history for follow-ups.",
    promptGuidelines: [
      "Use session_name for multi-turn conversations; use oneShot for independent questions",
      "Pick descriptive session names (e.g. 'refactor-auth', not 'session1')",
      "Default permissions are approve-reads; use approve-all only when Claude needs to write files",
    ],
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      session_name: Type.Optional(
        Type.String({ description: "Named session (auto-created if needed)" }),
      ),
      permissions: Type.Optional(
        Type.Union(
          [
            Type.Literal("approve-all"),
            Type.Literal("approve-reads"),
            Type.Literal("deny-all"),
          ],
          { description: "Permission level (default: approve-reads)" },
        ),
      ),
      oneShot: Type.Optional(
        Type.Boolean({
          description: "Stateless one-shot mode — skips session setup but doesn't allow for followups",
        }),
      ),
      noWait: Type.Optional(
        Type.Boolean({ description: "Queue prompt and return immediately" }),
      ),
      timeout: Type.Optional(
        Type.Number({ description: "Max seconds to wait" }),
      ),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("ClaudeAcp "));
      if (args.session_name) text += theme.fg("accent", `[${args.session_name}] `);
      else if (args.oneShot) text += theme.fg("accent", "[one-shot] ");
      const preview =
        args.prompt.length > 200
          ? args.prompt.substring(0, 200) + "..."
          : args.prompt;
      text += theme.fg("muted", `"${preview}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded, isPartial }, theme) {
      const details = result.details as ClaudeAcpDetails | undefined;

      if (isPartial) {
        const elapsed = details?.executionTime
          ? `${(details.executionTime / 1000).toFixed(0)}s`
          : "";
        let text = theme.fg("warning", `⟳ Claude working${elapsed ? ` (${elapsed})` : ""}...`);
        const responseText = result.content[0];
        if (responseText?.type === "text" && responseText.text) {
          const lastLine = responseText.text.trim().split("\n").pop() || "";
          if (lastLine) text += ` ${theme.fg("muted", lastLine.substring(0, 120))}`;
        }
        return new Text(text, 0, 0);
      }

      const responseText = result.content[0];
      const content = responseText?.type === "text" ? responseText.text : "";
      let text = statusText(theme, details?.exitCode, "Claude responded", content);

      if (!expanded) {
        if (content) text += ` ${theme.fg("muted", firstLinePreview(content))}`;
        text += ` (${keyHint("expandTools", "for details")})`;
        return new Text(text, 0, 0);
      }

      if (details) {
        if (details.session_name)
          text += `\n${theme.fg("dim", `Session: ${details.session_name}`)}`;
        text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
        text += `\n\n${theme.fg("muted", "─ Prompt (" + details.promptLength + " chars) " + "─".repeat(Math.max(0, 26 - String(details.promptLength).length)))}`;
        text += `\n${details.prompt}`;
      }

      if (content) {
        text += `\n\n${theme.fg("muted", "─ Response " + "─".repeat(29))}\n${content}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(id, params, signal, onUpdate) {
      const sessionName = params.session_name && params.session_name !== "undefined" ? params.session_name : undefined;

      if (sessionName) await ensureSession(sessionName);

      // Build acpx args
      const args: string[] = ["--format", "quiet"];
      args.push(`--${params.permissions || "approve-reads"}`);
      if (params.timeout) args.push("--timeout", String(params.timeout));
      args.push("claude");
      if (params.oneShot) args.push("exec");
      else if (sessionName) args.push("-s", sessionName);
      if (params.noWait) args.push("--no-wait");
      args.push("--file", "-");

      const startTime = Date.now();
      const result = await spawnAcpx({
        args,
        prompt: params.prompt,
        signal,
        onStdout(stdout) {
          onUpdate?.({
            content: [{ type: "text", text: stdout.trim() }],
            details: {
              session_name: sessionName,
              prompt: params.prompt,
              promptLength: params.prompt.length,
              executionTime: Date.now() - startTime,
            } satisfies ClaudeAcpDetails,
          });
        },
      });

      const details: ClaudeAcpDetails = {
        session_name: sessionName,
        prompt: params.prompt,
        promptLength: params.prompt.length,
        executionTime: result.executionTime,
        exitCode: result.exitCode,
      };
      return { content: [{ type: "text", text: result.text }], details };
    },
  });
}

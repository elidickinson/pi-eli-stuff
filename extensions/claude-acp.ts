import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { keyHint } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ClaudeAcpDetails {
  session_name?: string;
  promptLength: number;
  executionTime: number;
  exitCode?: number;
}

/** Run a one-shot acpx claude exec prompt, returning { text, exitCode, executionTime }. */
function runClaudeExec(
  prompt: string,
  signal?: AbortSignal,
): Promise<{ text: string; exitCode: number | undefined; executionTime: number }> {
  const startTime = Date.now();
  return new Promise((resolve, reject) => {
    const proc = spawn("acpx", ["--format", "quiet", "--approve-reads", "claude", "exec", "--file", "-"], {
      cwd: process.cwd(),
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk: Buffer) => (stdout += chunk));
    proc.stderr.on("data", (chunk: Buffer) => (stderr += chunk));

    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      resolve({
        text: stdout.trim() || stderr.trim() || `(exit ${code})`,
        exitCode: code ?? undefined,
        executionTime: Date.now() - startTime,
      });
    });
    proc.on("error", reject);

    proc.stdin.write(prompt);
    proc.stdin.end();
  });
}

export default function (pi: ExtensionAPI) {
  // /claude slash command — inline one-shot, result stays in context
  const CLAUDE_MSG_TYPE = "claude-acp-response";

  pi.registerMessageRenderer(CLAUDE_MSG_TYPE, (message, { expanded }, theme) => {
    const details = message.details as { executionTime: number; exitCode?: number } | undefined;
    const isError = details?.exitCode != null && details.exitCode !== 0;
    let text = isError
      ? theme.fg("error", `✗ Claude error (exit ${details?.exitCode})`)
      : theme.fg("success", "✓ Claude");
    if (details?.executionTime) {
      text += theme.fg("dim", ` ${(details.executionTime / 1000).toFixed(1)}s`);
    }
    const content = typeof message.content === "string" ? message.content : message.content[0]?.text || "";
    if (!expanded) {
      const firstLine = content.split("\n")[0] || "";
      text += ` ${theme.fg("muted", firstLine.substring(0, 150))}${firstLine.length > 150 ? "..." : ""}`;
    } else {
      text += `\n\n${content}`;
    }
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
      const result = await runClaudeExec(prompt);
      pi.sendMessage(
        {
          customType: CLAUDE_MSG_TYPE,
          content: result.text,
          display: true,
          details: { executionTime: result.executionTime, exitCode: result.exitCode },
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

      const isError = details?.exitCode != null && details.exitCode !== 0;
      let text = isError
        ? theme.fg("error", `✗ Claude ACP error (exit ${details?.exitCode})`)
        : theme.fg("success", "✓ Claude responded");

      const responseText = result.content[0];
      const firstLine =
        responseText?.type === "text" && responseText.text
          ? responseText.text.split("\n")[0]
          : null;

      if (!expanded) {
        if (firstLine) {
          text += ` ${theme.fg("muted", firstLine.substring(0, 150))}${firstLine.length > 150 ? "..." : ""}`;
        }
        text += ` (${keyHint("expandTools", "for details")})`;
        return new Text(text, 0, 0);
      }

      if (details) {
        if (details.session_name)
          text += `\n${theme.fg("dim", `Session: ${details.session_name}`)}`;
        text += `\n${theme.fg("dim", `Prompt: ${details.promptLength} chars`)}`;
        text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
      }

      if (responseText?.type === "text" && responseText.text) {
        text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${responseText.text}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(id, params, signal, onUpdate) {
      const startTime = Date.now();
      const sessionName = params.session_name && params.session_name !== "undefined" ? params.session_name : undefined;

      // Auto-create session if needed
      if (sessionName) {
        await new Promise<void>((resolve, reject) => {
          const timeout = setTimeout(() => {
            proc.kill();
            reject(new Error("sessions ensure timed out"));
          }, 10000);

          const proc = spawn("acpx", ["claude", "sessions", "ensure", "--name", sessionName!], {
            stdio: ["ignore", "pipe", "pipe"],
            cwd: process.cwd(),
          });
          let stderr = "";
          proc.stderr?.on("data", (c) => (stderr += c));
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

      // Build acpx args: acpx [--format quiet] [--permissions] [--timeout N] claude [-s session | exec] [--no-wait] --file -
      const args: string[] = [];

      // Use quiet format to get clean output
      args.push("--format", "quiet");

      const perm = params.permissions || "approve-reads";
      args.push(`--${perm}`);

      if (params.timeout) args.push("--timeout", String(params.timeout));

      args.push("claude");

      if (params.oneShot) {
        args.push("exec");
      } else if (sessionName) {
        args.push("-s", sessionName);
      }

      if (params.noWait) args.push("--no-wait");

      args.push("--file", "-");

      return new Promise((resolve, reject) => {
        const proc = spawn("acpx", args, {
          cwd: process.cwd(),
          stdio: ["pipe", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk;
          onUpdate?.({
            content: [{ type: "text", text: stdout.trim() }],
            details: {
              session_name: sessionName,
              promptLength: params.prompt.length,
              executionTime: Date.now() - startTime,
            } satisfies ClaudeAcpDetails,
          });
        });
        proc.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk;
        });

        const onAbort = () => proc.kill();
        signal?.addEventListener("abort", onAbort, { once: true });

        proc.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) return reject(new Error("aborted"));
          const text = stdout.trim() || stderr.trim() || `(exit ${code})`;
          const details: ClaudeAcpDetails = {
            session_name: sessionName,
            promptLength: params.prompt.length,
            executionTime: Date.now() - startTime,
            exitCode: code ?? undefined,
          };
          resolve({ content: [{ type: "text", text }], details });
        });

        proc.on("error", reject);

        // Write prompt to stdin and close
        proc.stdin.write(params.prompt);
        proc.stdin.end();
      });
    },
  });
}

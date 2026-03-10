import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface ClaudeAcpDetails {
  session?: string;
  promptLength: number;
  executionTime: number;
  exitCode?: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ClaudeAcp",
    label: "Claude ACP",
    description:
      "Send a prompt to Claude via ACP (Agent Client Protocol). " +
      "Passes prompt via stdin to avoid shell quoting issues. " +
      "Session must already exist (create via bash: acpx claude sessions new --name <name>).",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      session: Type.Optional(
        Type.String({ description: "Named session (must already exist)" }),
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
      exec: Type.Optional(
        Type.Boolean({
          description: "Stateless one-shot mode (no session needed)",
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
      if (args.session) text += theme.fg("accent", `[${args.session}] `);
      else if (args.exec) text += theme.fg("accent", "[exec] ");
      const preview =
        args.prompt.length > 200
          ? args.prompt.substring(0, 200) + "..."
          : args.prompt;
      text += theme.fg("muted", `"${preview}"`);
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as ClaudeAcpDetails | undefined;
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
        return new Text(text, 0, 0);
      }

      if (details) {
        if (details.session)
          text += `\n${theme.fg("dim", `Session: ${details.session}`)}`;
        text += `\n${theme.fg("dim", `Prompt: ${details.promptLength} chars`)}`;
        text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
      }

      if (responseText?.type === "text" && responseText.text) {
        text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${responseText.text}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(id, params, signal) {
      const startTime = Date.now();

      // Build acpx args: acpx [--permissions] [--timeout N] claude [-s session | exec] [--no-wait] --file -
      const args: string[] = [];

      const perm = params.permissions || "approve-reads";
      args.push(`--${perm}`);

      if (params.timeout) args.push("--timeout", String(params.timeout));

      args.push("claude");

      if (params.exec) {
        args.push("exec");
      } else if (params.session) {
        args.push("-s", params.session);
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
            session: params.session,
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

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskClaudeDetails {
  model: string;
  promptLength: number;
  executionTime: number;
  exitCode?: number;
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "AskClaude",
    label: "Ask Claude",
    description: "Send a prompt to Claude Code and return the response. Use by request or if you're really stuck.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      model: Type.Optional(Type.String({ description: "Model (e.g. opus, sonnet)" })),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("AskClaude "));
      const preview = args.prompt.length > 120 ? args.prompt.substring(0, 120) + "..." : args.prompt;
      text += theme.fg("muted", `"${preview}"`);
      if (args.model) text += ` ${theme.fg("accent", `[${args.model}]`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as AskClaudeDetails | undefined;
      const isError = details?.exitCode != null && details.exitCode !== 0;
      let text = isError
        ? theme.fg("error", `✗ Claude error (exit ${details?.exitCode})`)
        : theme.fg("success", "✓ Claude responded");
      if (!expanded) return new Text(text, 0, 0);

      if (details) {
        text += `\n${theme.fg("dim", `Model: ${details.model}`)}`;
        text += `\n${theme.fg("dim", `Prompt: ${details.promptLength} chars`)}`;
        text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
      }

      const responseText = result.content[0];
      if (responseText?.type === "text" && responseText.text) {
        text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${responseText.text}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(id, params, signal) {
      const startTime = Date.now();
      const args = ["-p", params.prompt];
      if (params.model) args.push("--model", params.model);

      return new Promise((resolve, reject) => {
        const proc = spawn("claude", args, {
          cwd: process.cwd(),
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        proc.stdout.on("data", (chunk) => { stdout += chunk; });
        proc.stderr.on("data", (chunk) => { stderr += chunk; });

        const onAbort = () => proc.kill();
        signal?.addEventListener("abort", onAbort, { once: true });

        proc.on("close", (code) => {
          signal?.removeEventListener("abort", onAbort);
          if (signal?.aborted) return reject(new Error("aborted"));
          const text = stdout.trim() || stderr.trim() || `(exit ${code})`;
          const model = params.model || "default";
          const details: AskClaudeDetails = {
            model,
            promptLength: params.prompt.length,
            executionTime: Date.now() - startTime,
            exitCode: code ?? undefined,
          };
          resolve({ content: [{ type: "text", text }], details });
        });

        proc.on("error", reject);
      });
    },
  });
}

import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "AskClaude",
    label: "Ask Claude",
    description: "Send a prompt to Claude Code and return the response. Use by request or if you're really stuck.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      model: Type.Optional(Type.String({ description: "Model (e.g. opus, sonnet)" })),
    }),
    async execute(id, params, signal) {
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
          resolve({ content: [{ type: "text", text }], details: {} });
        });

        proc.on("error", reject);
      });
    },
  });
}

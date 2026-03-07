import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

function spawnPi(args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("pi", args, { stdio: ["ignore", "pipe", "pipe"], cwd: process.cwd() });
    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (chunk) => { stdout += chunk; });
    proc.stderr.on("data", (chunk) => { stderr += chunk; });

    const onAbort = () => proc.kill();
    signal?.addEventListener("abort", onAbort, { once: true });

    proc.on("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (signal?.aborted) return reject(new Error("aborted"));
      resolve(stdout.trim() || stderr.trim() || `(exit ${code})`);
    });

    proc.on("error", reject);
  });
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "ListPiModels",
    label: "List Pi Models",
    description: "List all available pi models. Returns a clean list of provider/model IDs.",
    parameters: Type.Object({}),
    async execute(id, params, signal) {
      const output = await spawnPi(["--list-models"], signal);
      const lines = output.split("\n").slice(1); // Skip header
      const models = lines
        .map((line) => line.trim())
        .filter((line) => line)
        .map((line) => {
          const parts = line.split(/\s+/);
          return `${parts[0]}/${parts[1]}`; // Join provider and model
        });
      return { content: [{ type: "text", text: models.join("\n") }], details: {} };
    },
  });

  pi.registerTool({
    name: "AskPi",
    label: "Ask Pi",
    description: "Send a prompt to pi and return the response. Only makes sense to call as a background agent and/or with a different model. Read-only: no edit/write/bash tools.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      model: Type.Optional(Type.String({
        description: "Model ID (format: provider/model, e.g. openrouter/deepseek/deepseek-v3.2). Use ListPiModels to see available options.",
      })),
    }),
    async execute(id, params, signal) {
      const args = ["-p", "--tools", "read", "-ne", params.prompt];
      if (params.model) args.push("--model", params.model);

      return new Promise((resolve, reject) => {
        const proc = spawn("pi", args, {
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

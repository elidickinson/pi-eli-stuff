import { spawn } from "node:child_process";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

interface AskPiDetails {
  model?: string;
  promptLength: number;
  executionTime: number;
  exitCode?: number;
}

interface ListPiModelsDetails {
  modelCount: number;
  executionTime: number;
  exitCode?: number;
}

function spawnPi(args: string[], signal?: AbortSignal): Promise<{ stdout: string; stderr: string; code: number | null }> {
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
      resolve({ stdout: stdout.trim(), stderr: stderr.trim(), code });
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
    renderResult(result, { expanded }, theme) {
      const details = result.details as ListPiModelsDetails | undefined;
      const isError = details?.exitCode != null && details.exitCode !== 0;
      const modelCount = details?.modelCount ?? 0;

      let text = isError
        ? theme.fg("error", `✗ List failed (exit ${details?.exitCode})`)
        : theme.fg("success", `✓ Found ${modelCount} models`);

      const responseText = result.content[0];
      const firstLine = responseText?.type === "text" && responseText.text
        ? responseText.text.split("\n")[0]
        : null;

      if (!expanded) {
        if (firstLine) {
          text += ` ${theme.fg("muted", firstLine.substring(0, 100))}${firstLine.length > 100 ? "..." : ""}`;
        }
        return new Text(text, 0, 0);
      }

      if (details) {
        text += `\n${theme.fg("dim", `Time: ${(details.executionTime / 1000).toFixed(2)}s`)}`;
      }

      if (responseText?.type === "text" && responseText.text) {
        text += `\n\n${theme.fg("muted", "─".repeat(40))}\n${responseText.text}`;
      }
      return new Text(text, 0, 0);
    },
    async execute(id, params, signal) {
      const startTime = Date.now();
      const { stdout, stderr, code } = await spawnPi(["--list-models"], signal);

      const lines = stdout.split("\n").slice(1); // Skip header
      const models = lines
        .map((line) => line.trim())
        .filter((line) => line)
        .map((line) => {
          const parts = line.split(/\s+/);
          return `${parts[0]}/${parts[1]}`; // Join provider and model
        });

      const details: ListPiModelsDetails = {
        modelCount: models.length,
        executionTime: Date.now() - startTime,
        exitCode: code ?? undefined,
      };

      const text = models.join("\n") || stderr || `(exit ${code})`;
      return { content: [{ type: "text", text }], details };
    },
  });

  pi.registerTool({
    name: "AskPi",
    label: "Ask Pi",
    description: "Send a prompt to pi and return the response. Only makes sense to call as a background agent and/or with a different model. Read-only: no edit/write/bash tools.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The prompt to send" }),
      model: Type.Optional(Type.String({
        description: "Model ID (format: provider/model, e.g. minimax/MiniMax-M2.5-highspeed, openrouter/qwen/qwen3.5-397b-a17b, deepseek/deepseek-reasoner). Use ListPiModels to see available options.",
      })),
    }),
    renderCall(args, theme) {
      let text = theme.fg("toolTitle", theme.bold("AskPi "));
      const preview = args.prompt.length > 200 ? args.prompt.substring(0, 200) + "..." : args.prompt;
      text += theme.fg("muted", `"${preview}"`);
      if (args.model) text += ` ${theme.fg("accent", `[${args.model}]`)}`;
      return new Text(text, 0, 0);
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as AskPiDetails | undefined;
      const isError = details?.exitCode != null && details.exitCode !== 0;
      let text = isError
        ? theme.fg("error", `✗ Pi error (exit ${details?.exitCode})`)
        : theme.fg("success", "✓ Pi responded");

      const responseText = result.content[0];
      const firstLine = responseText?.type === "text" && responseText.text
        ? responseText.text.split("\n")[0]
        : null;

      if (!expanded) {
        if (firstLine) {
          text += ` ${theme.fg("muted", firstLine.substring(0, 150))}${firstLine.length > 150 ? "..." : ""}`;
        }
        return new Text(text, 0, 0);
      }

      if (details) {
        text += `\n${theme.fg("dim", `Model: ${details.model || "default"}`)}`;
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

          const details: AskPiDetails = {
            model: params.model,
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

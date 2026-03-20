/**
 * Kagi Search Extension for pi
 *
 * Provides kagi_search and kagi_summarize tools using the Kagi API via kagi-ken.
 *
 * Token resolution: KAGI_SESSION_TOKEN env var > ~/.pi/agent/kagi-search.json > interactive prompt.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { search, summarize } from "kagi-ken";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CONFIG_PATH = join(homedir(), ".pi", "agent", "kagi-search.json");

function loadSavedToken(): string | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	try {
		const config = JSON.parse(readFileSync(CONFIG_PATH, "utf-8"));
		return config.sessionToken || undefined;
	} catch {
		return undefined;
	}
}

function saveToken(token: string): void {
	const dir = join(homedir(), ".pi", "agent");
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(CONFIG_PATH, JSON.stringify({ sessionToken: token }, null, 2) + "\n");
}

async function getToken(ctx: ExtensionContext): Promise<string> {
	const envToken = process.env.KAGI_SESSION_TOKEN;
	if (envToken) return envToken;

	const savedToken = loadSavedToken();
	if (savedToken) return savedToken;

	if (!ctx.hasUI) {
		throw new Error("KAGI_SESSION_TOKEN not set and no UI available to prompt. Set the env var or add token to ~/.pi/agent/kagi-search.json");
	}

	const entered = await ctx.ui.input("Kagi Session Token", "paste from Kagi Settings > Session Link");
	if (!entered) {
		throw new Error("Kagi session token is required.");
	}

	saveToken(entered);
	ctx.ui.notify("Kagi token saved to ~/.pi/agent/kagi-search.json", "info");
	return entered;
}

export default function kagiSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "kagi_search",
		label: "Kagi Search",
		description:
			"Search the web using Kagi, a high-quality search engine. Returns structured results with titles, URLs, and snippets.",
		promptSnippet: "Search the web via Kagi for high-quality, ad-free results",
		promptGuidelines: [
			"Use kagi_search when the user asks to search the web or find information online.",
			"Prefer kagi_search over other web search tools when available.",
		],
		parameters: Type.Object({
			query: Type.String({ description: "Search query" }),
			limit: Type.Optional(
				Type.Number({
					description: "Max results to return (default 10)",
					minimum: 1,
					maximum: 50,
				}),
			),
		}),

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("Kagi Search "));
			text += theme.fg("accent", `"${args.query}"`);
			if (args.limit) text += theme.fg("muted", ` [limit: ${args.limit}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { query: string; results: { title: string; url: string; snippet: string }[] } | undefined;
			const results = details?.results ?? [];

			if (!results.length) return new Text(theme.fg("muted", "No results found."), 0, 0);

			const preview = results.slice(0, 5);
			const lines = preview.map((r) =>
				`${theme.fg("text", r.title)}  ${theme.fg("dim", r.url)}`
			);

			let text = theme.fg("success", `✓ ${results.length} results`);
			text += "\n" + lines.join("\n");

			if (!expanded && results.length > 5) {
				text += "\n" + theme.fg("dim", `… ${results.length - 5} more`);
			}

			if (expanded) {
				// Show all results with snippets
				text = theme.fg("success", `✓ ${results.length} results`);
				text += "\n" + results.map((r) =>
					`${theme.fg("text", r.title)}\n${theme.fg("accent", r.url)}${r.snippet ? "\n" + theme.fg("muted", r.snippet) : ""}`
				).join("\n\n");
			}

			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const token = await getToken(ctx);
			const result = await search(params.query, token, params.limit);

			const results = result.data
				.filter((item: any) => item.t === 0)
				.map((item: any) => ({
					title: item.title as string,
					url: item.url as string,
					snippet: (item.snippet || "") as string,
				}));

			const formatted = results
				.map((r) => `## ${r.title}\n${r.url}\n${r.snippet}`)
				.join("\n\n");

			return {
				content: [{ type: "text", text: formatted || "No results found." }],
				details: { query: params.query, results },
			};
		},
	});

	pi.registerTool({
		name: "kagi_summarize",
		label: "Kagi Summarize",
		description:
			"Summarize a URL or text using Kagi Universal Summarizer. Returns a markdown summary.",
		parameters: Type.Object({
			input: Type.String({
				description: "URL to summarize, or raw text content",
			}),
			is_url: Type.Optional(
				Type.Boolean({
					description:
						"Whether input is a URL (default true if input looks like a URL)",
				}),
			),
			type: Type.Optional(
				StringEnum(["summary", "takeaway"] as const, {
					description:
						"Summary type: 'summary' for prose, 'takeaway' for key points (default: summary)",
				}),
			),
			language: Type.Optional(
				Type.String({
					description:
						"Output language code, e.g. EN, DE, JA, ES, FR, ZH (default: EN)",
				}),
			),
		}),

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("Kagi Summarize "));
			const preview = args.input.length > 100 ? args.input.substring(0, 100) + "…" : args.input;
			text += theme.fg("accent", preview);
			const flags: string[] = [];
			if (args.type) flags.push(args.type);
			if (args.language && args.language !== "EN") flags.push(args.language);
			if (flags.length) text += theme.fg("muted", ` [${flags.join(", ")}]`);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as { input: string; type: string; isUrl: boolean } | undefined;
			const body = result.content[0]?.type === "text" ? result.content[0].text : "";
			if (!body) return new Text(theme.fg("muted", "No summary generated."), 0, 0);

			const lines = body.split("\n");
			const previewLines = expanded ? lines : lines.slice(0, 5);
			let text = theme.fg("success", `✓ Summarized`) + " " + theme.fg("dim", details?.input || "");
			text += "\n" + previewLines.map((l) => theme.fg("toolOutput", l)).join("\n");

			if (!expanded && lines.length > 5) {
				text += "\n" + theme.fg("dim", `… ${lines.length - 5} more lines`);
			}

			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const token = await getToken(ctx);

			const isUrl =
				params.is_url ?? /^https?:\/\//.test(params.input);

			const result = await summarize(params.input, token, {
				type: params.type ?? "summary",
				language: params.language ?? "EN",
				isUrl,
			});

			return {
				content: [
					{
						type: "text",
						text: result.data.output || "No summary generated.",
					},
				],
				details: {
					input: params.input.slice(0, 200),
					type: params.type ?? "summary",
					isUrl,
				},
			};
		},
	});
}

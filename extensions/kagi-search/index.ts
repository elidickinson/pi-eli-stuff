/**
 * Kagi Search Extension for pi
 *
 * Provides kagi_search and kagi_summarize tools using the Kagi API via kagi-ken.
 *
 * Requires KAGI_SESSION_TOKEN env var (from Kagi Settings > Session Link).
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { StringEnum } from "@mariozechner/pi-ai";
import { search, summarize } from "kagi-ken";

function getToken(): string {
	const token = process.env.KAGI_SESSION_TOKEN;
	if (!token) {
		throw new Error(
			"KAGI_SESSION_TOKEN not set. Get your session token from Kagi Settings > Session Link.",
		);
	}
	return token;
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

		async execute(_toolCallId, params) {
			const token = getToken();
			const result = await search(params.query, token, params.limit);

			const formatted = result.data
				.filter((item: any) => item.t === 0)
				.map(
					(item: any) =>
						`## ${item.title}\n${item.url}\n${item.snippet || ""}`,
				)
				.join("\n\n");

			return {
				content: [
					{
						type: "text",
						text: formatted || "No results found.",
					},
				],
				details: { query: params.query, resultCount: result.data.length },
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

		async execute(_toolCallId, params) {
			const token = getToken();

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

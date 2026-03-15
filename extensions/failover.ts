/**
 * API Key Failover Extension
 *
 * Rotates to a backup API key when rate-limited, so pi's built-in
 * auto-retry uses the fresh key. Config: ~/.pi/agent/failover.json
 *
 * Keys are the primary env var name you already use. Values list
 * backup env var names to rotate through:
 *
 * {
 *   "ANTHROPIC_API_KEY": ["ANTHROPIC_API_KEY_2", "ANTHROPIC_API_KEY_3"],
 *   "OPENAI_API_KEY": ["OPENAI_API_KEY_2"]
 * }
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getAgentDir } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Config: primary env var → list of backup env var names
type FailoverConfig = Record<string, string[]>;

const RATE_LIMIT_RE =
	/overloaded|rate.?limit|too many requests|429|502|503|504|service.?unavailable/i;

// Provider name → primary env var name (as used by pi's getEnvApiKey)
const PROVIDER_ENV: Record<string, string> = {
	anthropic: "ANTHROPIC_API_KEY",
	openai: "OPENAI_API_KEY",
	google: "GEMINI_API_KEY",
	groq: "GROQ_API_KEY",
	cerebras: "CEREBRAS_API_KEY",
	xai: "XAI_API_KEY",
	openrouter: "OPENROUTER_API_KEY",
	mistral: "MISTRAL_API_KEY",
};

function loadConfig(): FailoverConfig {
	const path = join(getAgentDir(), "failover.json");
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch {
		return {};
	}
}

export default function (pi: ExtensionAPI) {
	const config = loadConfig();

	// Build reverse map: provider name → primary env var
	const envToProvider = new Map<string, string>();
	for (const [provider, envVar] of Object.entries(PROVIDER_ENV)) {
		envToProvider.set(envVar, provider);
	}

	// Snapshot all key values at startup (before any swaps mutate process.env)
	// and track current index (0 = primary)
	const resolvedKeys = new Map<string, string[]>();
	const keyIndex = new Map<string, number>();
	for (const [primaryEnv, backups] of Object.entries(config)) {
		if (!backups.length) continue;
		const values = [primaryEnv, ...backups]
			.map((name) => process.env[name])
			.filter((v): v is string => !!v);
		if (values.length < 2) continue;
		resolvedKeys.set(primaryEnv, values);
		keyIndex.set(primaryEnv, 0);
	}

	// provider name → primary env var (for looking up on rate limit)
	const providerToEnv = new Map<string, string>();
	for (const primaryEnv of resolvedKeys.keys()) {
		const provider = envToProvider.get(primaryEnv);
		if (provider) providerToEnv.set(provider, primaryEnv);
	}

	function displayName(primaryEnv: string): string {
		return envToProvider.get(primaryEnv) ?? primaryEnv;
	}

	function updateStatus(ctx: { ui: { setStatus(k: string, t: string | undefined): void; theme: any } }) {
		const parts: string[] = [];
		for (const [primaryEnv, idx] of keyIndex) {
			const keys = resolvedKeys.get(primaryEnv)!;
			if (idx === 0) continue;
			parts.push(`${displayName(primaryEnv)} ${idx + 1}/${keys.length}`);
		}
		ctx.ui.setStatus(
			"failover",
			parts.length ? ctx.ui.theme.fg("dim", `[${parts.join(", ")}]`) : undefined,
		);
	}

	pi.on("message_end", (event, ctx) => {
		const msg = event.message as Partial<AssistantMessage>;
		if (msg.stopReason !== "error" || !msg.errorMessage) return;
		if (!RATE_LIMIT_RE.test(msg.errorMessage)) return;

		const provider = msg.provider as string | undefined;
		if (!provider) return;

		const primaryEnv = providerToEnv.get(provider);
		if (!primaryEnv) return;

		const keys = resolvedKeys.get(primaryEnv)!;
		const current = keyIndex.get(primaryEnv) ?? 0;
		const next = (current + 1) % keys.length;
		keyIndex.set(primaryEnv, next);

		// Swap the env var so getEnvApiKey() picks up the new key on retry
		process.env[primaryEnv] = keys[next];

		const name = displayName(primaryEnv);
		ctx.ui.setStatus("failover", ctx.ui.theme.fg("dim", `[${name} ${next + 1}/${keys.length}]`));
		ctx.ui.notify(`Failover: ${name} → key ${next + 1}/${keys.length}`, "info");
	});

	pi.on("session_start", (_e, ctx) => updateStatus(ctx));
	pi.on("session_fork", (_e, ctx) => updateStatus(ctx));
	pi.on("session_switch", (_e, ctx) => updateStatus(ctx));
}

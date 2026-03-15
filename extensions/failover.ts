/**
 * API Key Failover Extension
 *
 * Rotates to a backup API key when rate-limited, so pi's built-in
 * auto-retry uses the fresh key. Zero config — just set env vars:
 *
 *   ANTHROPIC_API_KEY=sk-ant-xxx
 *   ANTHROPIC_API_KEY_2=sk-ant-yyy
 *   ANTHROPIC_API_KEY_3=sk-ant-zzz
 *
 * Auto-discovers _2, _3, ... suffixes for any known provider key.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { AssistantMessage } from "@mariozechner/pi-ai";

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

/** Snapshot key values from FOO_KEY, FOO_KEY_2, FOO_KEY_3, ... */
function discoverKeys(envVar: string): string[] {
	const keys: string[] = [];
	const primary = process.env[envVar];
	if (!primary) return keys;
	keys.push(primary);
	for (let i = 2; ; i++) {
		const val = process.env[`${envVar}_${i}`];
		if (!val) break;
		keys.push(val);
	}
	return keys;
}

export default function (pi: ExtensionAPI) {
	// Snapshot all key values at startup (before any swaps mutate process.env)
	const resolvedKeys = new Map<string, string[]>();
	const keyIndex = new Map<string, number>();
	const providerToEnv = new Map<string, string>();

	for (const [provider, envVar] of Object.entries(PROVIDER_ENV)) {
		const keys = discoverKeys(envVar);
		if (keys.length < 2) continue;
		resolvedKeys.set(envVar, keys);
		keyIndex.set(envVar, 0);
		providerToEnv.set(provider, envVar);
	}

	function updateStatus(ctx: { ui: { setStatus(k: string, t: string | undefined): void; theme: any } }) {
		const parts: string[] = [];
		for (const [envVar, idx] of keyIndex) {
			const keys = resolvedKeys.get(envVar)!;
			if (idx === 0) continue;
			// Find provider name for display
			const provider = Object.entries(PROVIDER_ENV).find(([, v]) => v === envVar)?.[0] ?? envVar;
			parts.push(`${provider} ${idx + 1}/${keys.length}`);
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

		const envVar = providerToEnv.get(provider);
		if (!envVar) return;

		const keys = resolvedKeys.get(envVar)!;
		const current = keyIndex.get(envVar) ?? 0;
		const next = (current + 1) % keys.length;
		keyIndex.set(envVar, next);

		// Swap the env var so getEnvApiKey() picks up the new key on retry
		process.env[envVar] = keys[next];

		ctx.ui.setStatus("failover", ctx.ui.theme.fg("dim", `[${provider} ${next + 1}/${keys.length}]`));
		ctx.ui.notify(`Failover: ${provider} → key ${next + 1}/${keys.length}`, "info");
	});

	pi.on("session_start", (_e, ctx) => updateStatus(ctx));
	pi.on("session_fork", (_e, ctx) => updateStatus(ctx));
	pi.on("session_switch", (_e, ctx) => updateStatus(ctx));
}

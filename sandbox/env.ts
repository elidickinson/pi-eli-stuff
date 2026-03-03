// Shared env-building logic for Gondolin VMs (used by index.ts and shell.ts)

// Pi provider env vars to forward into the guest VM.
// Mirrors the env var names in pi's getEnvApiKey() (packages/ai/src/env-api-keys.ts).
const PI_ENV_KEYS = [
  "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY",
  "GEMINI_API_KEY", "GROQ_API_KEY", "CEREBRAS_API_KEY", "XAI_API_KEY",
  "ZAI_API_KEY", "OPENROUTER_API_KEY", "MINIMAX_API_KEY",
  "MINIMAX_CN_API_KEY", "MISTRAL_API_KEY", "HF_TOKEN", "KIMI_API_KEY",
  "PARALLEL_API_KEY",
  "BR_AUTOSTART_PARAMS", "BR_AUTOSTART", "BR_PARAMS",
];

/** Build the env vars to inject into a Gondolin VM. */
export function buildVmEnv(): Record<string, string> {
  const env: Record<string, string> = {};

  for (const key of PI_ENV_KEYS) {
    if (process.env[key]) env[key] = process.env[key]!;
  }

  // GONDOLIN_ENV_FOO=bar on the host becomes FOO=bar in the guest
  const ENV_PREFIX = "GONDOLIN_ENV_";
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith(ENV_PREFIX) && v !== undefined) {
      env[k.slice(ENV_PREFIX.length)] = v;
    }
  }

  return env;
}

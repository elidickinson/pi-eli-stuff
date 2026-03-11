import { defineConfig } from "vitest/config";
import path from "node:path";

// Pi runtime packages aren't installed locally — stub them for tests
const piStubs = path.resolve(__dirname, "test/__pi-stubs.ts");

export default defineConfig({
	test: {
		include: ["extensions/**/*.test.ts"],
	},
	resolve: {
		alias: {
			"@mariozechner/pi-coding-agent": piStubs,
			"@mariozechner/pi-ai": piStubs,
			"@mariozechner/pi-tui": piStubs,
			"@sinclair/typebox": piStubs,
		},
	},
});

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerCommand("clear", {
		description: "Clear the editor and start a new session (alias for /new)",
		handler: async (_args, ctx) => {
			await ctx.newSession();
		},
	});
}

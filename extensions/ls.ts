import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createLsTool } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool(createLsTool(process.cwd()));
}

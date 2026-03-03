import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createFindTool } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool(createFindTool(process.cwd()));
}

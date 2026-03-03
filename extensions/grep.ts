import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { createGrepTool } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
	pi.registerTool(createGrepTool(process.cwd()));
}

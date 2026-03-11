import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const execAsync = promisify(exec);
const TMP_DIR = "/tmp";

// Binary file extensions to handle specially
const BINARY_EXTENSIONS = new Set([
	"pdf", "zip", "tar", "gz", "bz2", "rar", "7z",
	"jpg", "jpeg", "png", "gif", "webp", "svg", "ico",
	"mp4", "mp3", "wav", "avi", "mov", "wmv",
	"exe", "dmg", "deb", "rpm", "apk", "msi",
	"doc", "docx", "xls", "xlsx", "ppt", "pptx",
	"bin", "dat", "iso", "img",
]);

function isBinaryUrl(url: string): boolean {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		const lastDot = pathname.lastIndexOf(".");
		if (lastDot === -1) return false;
		const ext = pathname.slice(lastDot + 1).toLowerCase();
		return BINARY_EXTENSIONS.has(ext);
	} catch {
		return false;
	}
}

function getOutputPath(url: string): string {
	try {
		const urlObj = new URL(url);
		const pathname = urlObj.pathname;
		const lastDot = pathname.lastIndexOf(".");
		const ext = lastDot !== -1 ? pathname.slice(lastDot + 1).toLowerCase().replace(/[^a-z0-9]/g, "") : "bin";
		const filename = `fetch-${Date.now()}.${ext}`;
		return path.join(TMP_DIR, filename);
	} catch {
		return path.join(TMP_DIR, `fetch-${Date.now()}.bin`);
	}
}

export default function (pi: ExtensionAPI) {
	pi.registerTool({
		name: "fetch",
		description: "Fetch a URL and return content. For HTML, returns markdown. For binary files, saves to /tmp and returns path.",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			proxy: Type.Optional(
				Type.Boolean({
					description: "Use proxy to bypass restrictions (requires UNBLOCKER_USER and UNBLOCKER_PASS env vars)",
				})
			),
			js_render: Type.Optional(
				Type.Boolean({
					description: "Render JavaScript before fetching (requires proxy=true, appends _render-1 to proxy password)",
				})
			),
			max_length: Type.Optional(
				Type.Number({
					description: "Maximum characters to return (default: 100000, set to -1 for no limit)",
				})
			),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			const { url, proxy, js_render, max_length = 100000 } = params;

			// Auto-enable proxy if js_render is requested
			const useProxy = js_render || proxy;

			// Validate proxy settings
			if (useProxy) {
				const user = process.env.UNBLOCKER_USER;
				const pass = process.env.UNBLOCKER_PASS;
				if (!user || !pass) {
					return {
						content: [
							{
								type: "text",
								text: "Error: proxy requires UNBLOCKER_USER and UNBLOCKER_PASS environment variables",
							},
						],
						details: {},
					};
				}
			}

			// Create temp file for fetch output (avoid shell interpolation)
			const randomSuffix = Math.random().toString(36).slice(2, 10);
			const tempFile = path.join(TMP_DIR, `fetch-${Date.now()}-${randomSuffix}.tmp`);
			let tempCleanup = true;

			try {
				// Build curl command
				const curlCmd = useProxy
					? buildProxyCurlCommand(url, js_render)
					: `curl_chrome145 -sL`;

				// Fetch to temp file
				await execAsync(`${curlCmd} ${quote(url)} -o ${quote(tempFile)}`, { signal });

				// Check if it's binary by reading first few bytes
				const isBinary = await checkIsBinary(tempFile);

				if (isBinary || isBinaryUrl(url)) {
					// Binary content - rename to proper extension
					const outPath = getOutputPath(url);
					tempCleanup = false;
					fs.renameSync(tempFile, outPath);
					const contentType = await getContentType(outPath);
					return {
						content: [
							{
								type: "text",
								text: `Binary file saved to ${outPath}`,
							},
						],
						details: { path: outPath, type: contentType || "unknown" },
					};
				}

				// Text content - convert to markdown
				const { stdout } = await execAsync(`html2markdown ${quote(tempFile)}`, {
					signal,
					maxBuffer: 10 * 1024 * 1024,
				});

				let content = stdout;

				// Truncate if needed (-1 or undefined means no limit)
				if (max_length !== -1 && max_length !== undefined && content.length > max_length) {
					content = content.slice(0, max_length);
					content += `\n\n... (truncated at ${max_length} characters)`;
				}

				return {
					content: [{ type: "text", text: content }],
					details: {},
				};
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return {
					content: [
						{
							type: "text",
							text: `Failed to fetch URL: ${message}`,
						},
					],
					details: {},
				};
			} finally {
				if (tempCleanup && fs.existsSync(tempFile)) {
					fs.unlinkSync(tempFile);
				}
			}
		},
	});
}

function quote(str: string): string {
	return `'${str.replace(/'/g, "'\\''")}'`;
}

async function checkIsBinary(filePath: string): Promise<boolean> {
	try {
		const buffer = Buffer.alloc(512);
		const fd = fs.openSync(filePath, "r");
		fs.readSync(fd, buffer, 0, 512, 0);
		fs.closeSync(fd);

		// Check for null bytes or high byte ratio
		let nullBytes = 0;
		let highBytes = 0;
		for (let i = 0; i < buffer.length; i++) {
			if (buffer[i] === 0) nullBytes++;
			if (buffer[i] > 127) highBytes++;
		}

		// If more than 1% null bytes or 30% high bytes, likely binary
		return nullBytes > 5 || highBytes > buffer.length * 0.3;
	} catch {
		return false;
	}
}

function buildProxyCurlCommand(url: string, jsRender: boolean | undefined): string {
	const user = process.env.UNBLOCKER_USER!;
	let pass = process.env.UNBLOCKER_PASS!;

	if (jsRender) {
		pass = pass + "_render-1";
	}

	const proxyUrl = `http://${user}:${pass}@unblocker.iproyal.com:12323`;
	return `curl -k -x ${quote(proxyUrl)} -L`;
}

async function getContentType(filePath: string): Promise<string | null> {
	try {
		const { stdout } = await execAsync(`file --mime-type -b ${quote(filePath)}`);
		return stdout.trim();
	} catch {
		return null;
	}
}

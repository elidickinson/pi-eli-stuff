import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@mariozechner/pi-coding-agent";
import { exec } from "child_process";
import { promisify } from "util";
import * as path from "path";
import * as os from "os";
import * as fs from "fs";

const execAsync = promisify(exec);
const TMP_DIR = "/tmp";

interface FetchConfig {
	proxyUser?: string;
	proxyPass?: string;
}

function getConfig(): FetchConfig {
	const configPath = path.join(os.homedir(), ".pi", "agent", "fetch.json");
	try {
		const content = fs.readFileSync(configPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return {};
	}
}

// Binary file extensions to handle specially
const BINARY_EXTENSIONS = new Set([
	"pdf", "zip", "tar", "gz", "bz2", "rar", "7z",
	"jpg", "jpeg", "png", "gif", "webp", "ico",
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
		description: "Fetch a URL and return readable content as markdown. Best-effort for binary files (saves to /tmp).",
		parameters: Type.Object({
			url: Type.String({ description: "URL to fetch" }),
			proxy: Type.Optional(
				Type.Boolean({
					description: "Use proxy to bypass restrictions (requires IPROYAL_UNBLOCKER_USER/IPROYAL_UNBLOCKER_PASS env vars or ~/.pi/agent/fetch.json config)",
				})
			),
			js_render: Type.Optional(
				Type.Boolean({
					description: "Render JavaScript before fetching (requires proxy=true, appends _render-1 to proxy password)",
				})
			),
			return_markdown: Type.Optional(
				Type.Boolean({
					description: "Convert HTML to markdown (default: true). If false, returns raw HTML.",
				})
			),
			max_length: Type.Optional(
				Type.Number({
					description: "Maximum characters to return (default: 40000, set to -1 for no limit)",
				})
			),
		}),
		async execute(id, params, signal, onUpdate, ctx) {
			const { url, proxy, js_render, return_markdown = true, max_length = 40000 } = params;
			const config = getConfig();

			// Auto-enable proxy if js_render is requested
			const useProxy = js_render || proxy;

			// Validate proxy settings
			const proxyUser = config.proxyUser || process.env.IPROYAL_UNBLOCKER_USER;
			const proxyPass = config.proxyPass || process.env.IPROYAL_UNBLOCKER_PASS;

			if (useProxy) {
				if (!proxyUser || !proxyPass) {
					return {
						content: [
							{
								type: "text",
								text: "Error: proxy requires IPROYAL_UNBLOCKER_USER/IPROYAL_UNBLOCKER_PASS env vars or ~/.pi/agent/fetch.json config with proxyUser/proxyPass",
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
					? buildProxyCurlCommand(proxyUser!, proxyPass!, js_render)
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

				// Text content
				let content: string;
				if (return_markdown) {
					// Convert to markdown
					const { stdout } = await execAsync(`html2markdown ${quote(tempFile)}`, {
						signal,
						maxBuffer: 10 * 1024 * 1024,
					});
					content = stdout;
				} else {
					// Return raw HTML
					content = fs.readFileSync(tempFile, "utf-8");
				}

				// Truncate if needed (-1 means no limit)
				if (max_length !== -1 && content.length > max_length) {
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
		const bytesRead = fs.readSync(fd, buffer, 0, 512, 0);
		fs.closeSync(fd);

		// Check for null bytes or high byte ratio
		let nullBytes = 0;
		let highBytes = 0;
		for (let i = 0; i < bytesRead; i++) {
			if (buffer[i] === 0) nullBytes++;
			if (buffer[i] > 127) highBytes++;
		}

		// If more than 1% null bytes or 30% high bytes, likely binary
		return nullBytes > 5 || highBytes > bytesRead * 0.3;
	} catch {
		return false;
	}
}

function buildProxyCurlCommand(
	user: string,
	pass: string,
	jsRender: boolean | undefined
): string {
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

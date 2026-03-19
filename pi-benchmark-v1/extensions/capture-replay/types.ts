/**
 * Types for the capture-replay extension
 */

export interface CaptureMetadata {
	id: string; // "capt-abc123"
	name?: string; // User-provided label
	createdAt: string; // ISO timestamp
	originalCwd: string; // Absolute path where captured
	sessionFile: string; // Path within tarball

	// Tarball stats
	tarballPath: string; // .pi-captures/<id>.tar.gz
	tarballSize: number; // Bytes

	// Content summary
	fileCount: number;
	totalSize: number;

	// First message for display
	firstUserMessage: string;
	messageCount: number;

	// Settings at capture time
	model?: { provider: string; id: string };
	thinkingLevel?: string;
}

export interface CaptureIndex {
	version: 1;
	captures: CaptureMetadata[];
}

export interface TarballStats {
	fileCount: number;
	totalSize: number; // Bytes
}

export interface ReplayOptions {
	targetDir: string;
	captureId: string;
	sessionOnly: boolean;
}
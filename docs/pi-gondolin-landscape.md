# Pi-Gondolin Integration Landscape

## Overview

Research into existing pi-gondolin integrations to understand the current state and identify opportunities for improvement.

## Existing Integrations

### 1. Official Gondolin Example
**Location:** `/workspace/vendor/gondolin/host/examples/pi-gondolin.ts`

**Approach:** Shell-based file operations via `vm.exec()`
- Uses `/bin/cat` for reading files
- Uses `/bin/mkdir -p` for creating directories
- Uses `/bin/sh -lc` for shell commands
- Files passed via base64 encoding for writes (to avoid shell quoting issues)

**Key Features:**
- Standard reference implementation
- Demonstrates `RealFSProvider` with `vfs.mounts`
- Basic tool overrides (read, write, edit, bash)

### 2. pasky/pi-gondolin
**Location:** https://github.com/pasky/pi-gondolin  
**Last Updated:** February 18, 2026  
**Commits:** 2 total

**Approach:** Nearly identical to official example
- Same shell-based file operations
- Slightly better code organization with separator comments
- Cleaned up unused parameters
- Fixed buffer encoding bug (see below)

**Key Features:**
- Better documentation with installation requirements
- Improved code readability with section dividers
- Bug fix for `Buffer.from()` handling

### 3. Our Integration (`/workspace/sandbox/index.ts`)
**Approach:** Shell-based (like others) + Claude Code OAuth

**Unique Features:**
- **Claude Code OAuth token injection**: Automatically extracts Claude Code OAuth token from macOS Keychain and passes to guest as `CLAUDE_CODE_OAUTH_TOKEN`
- Better session status notifications

## Common Pattern: Shell-Based File Operations

**All three implementations use shell commands instead of `VM.fs` API:**

```typescript
// Reading files
const r = await vm.exec(["/bin/cat", guestPath]);

// Writing files (via base64 to avoid shell escaping)
const b64 = Buffer.from(content).toString("base64");
const script = [
  `set -eu`,
  `mkdir -p ${shQuote(dir)}`,
  `echo ${shQuote(b64)} | base64 -d > ${shQuote(guestPath)}`,
].join("\n");
const r = await vm.exec(["/bin/sh", "-lc", script]);

// Directory operations
await vm.exec(["/bin/mkdir", "-p", guestDir]);

// File access checks
await vm.exec(["/bin/sh", "-lc", `test -r ${shQuote(guestPath)}`]);
```

## The Untapped: `VM.fs` API

Gondolin provides a direct filesystem API at `vm.fs` that none of the existing integrations use:

**Available Methods:**
- `vm.fs.readFile(path)` - Read file contents
- `vm.fs.writeFile(path, content)` - Write file contents
- `vm.fs.stat(path)` - Get file metadata
- `vm.fs.mkdir(path)` - Create directory
- `vm.fs.listDir(path)` - List directory contents
- `vm.fs.access(path)` - Check file accessibility
- `vm.fs.rename(from, to)` - Move/rename files
- `vm.fs.deleteFile(path)` - Delete files

**Advantages of using `VM.fs`:**
- **Cleaner API**: Direct JavaScript calls vs shell commands
- **Better error handling**: Native errors vs parsing shell exit codes
- **No shell escaping**: No need for base64 encoding
- **Potentially faster**: No shell process overhead
- **More reliable**: No shell configuration differences

## Bug Fixes Applied

### 1. Buffer Encoding Bug (from pasky/pi-gondolin)

**Issue:** Our `writeFile` was using `Buffer.from(content, "utf8")` which incorrectly handles already-buffered content.

```typescript
// Before (potentially buggy):
const b64 = Buffer.from(content, "utf8").toString("base64");

// After (correct):
const b64 = Buffer.from(content).toString("base64");
```

**Impact:** If content was already a Buffer, the `"utf8"` encoding would cause double-encoding issues.

### 2. Path Validation Bug

**Issue:** Our `toGuestPath()` function rejected **all** absolute paths, even those within the workspace.

```typescript
// Before:
if (rel.startsWith("..") || path.isAbsolute(rel)) {
  throw new Error(`path escapes workspace: ${localPath}`);
}
```

**Fix:** Separate handling for absolute vs relative paths:
- Absolute paths: Verify they're within `localCwd` (allow `/workspace/foo`)
- Relative paths: Resolve against `localCwd` first, then verify

```typescript
if (path.isAbsolute(localPath)) {
  // Absolute path: must be within localCwd
  const rel = path.relative(localCwd, localPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${localPath}`);
  }
  // ... process absolute path
} else {
  // Relative path: resolve against localCwd
  const absPath = path.resolve(localCwd, localPath);
  const rel = path.relative(localCwd, absPath);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`path escapes workspace: ${absPath}`);
  }
  // ... process relative path
}
```

## Opportunities for Improvement

### High Priority

1. **Migrate to `VM.fs` API**
   - Replace all shell-based file operations with direct `vm.fs` calls
   - Benefits: Cleaner code, better errors, no shell escaping overhead
   - Estimated effort: Medium (requires testing all operations)

2. **Better Error Messages**
   - Map Gondolin-specific errors to user-friendly messages
   - Include context (file path, operation, suggested fix)

### Medium Priority

3. **Code Organization Improvements** (from pasky/pi-gondolin)
   - Add section separator comments:
     ```typescript
     // ---------------------------------------------------------------------------
     // Path helpers
     // ---------------------------------------------------------------------------
     ```
   - Improve documentation with installation requirements

4. **Support for Multiple Mounts**
   - Allow mounting multiple directories (e.g., cache dir, config dir)
   - Could be useful for projects with separate input/output directories

5. **File Watching Integration**
   - If Gondolin supports it, add file watching capabilities
   - Enable auto-refresh when files change on host

### Low Priority

6. **Performance Monitoring**
   - Track VM startup time, operation latency
   - Add optional debug logging
   - Provide performance metrics to user

7. **Configuration Options**
   - Allow users to configure VM options (CPU, memory timeouts)
   - Make OAuth token extraction configurable/opt-out

8. **Snapshot Support**
   - Leverage Gondolin's storage snapshots for faster restart
   - Could cache VM state after first session

## Observations

- **No modern examples**: Despite `VM.fs` being available, no integrations use it
- **Shell approach works but is hacky**: Base64 encoding for writes, shell escaping everywhere
- **Community is small**: Only 2 known integrations (official + pasky's fork)
- **Our OAuth feature is unique**: No other example handles authentication token injection

## Conclusion

Our integration is competitive with existing ones. The main improvement opportunity is migrating to `VM.fs` API, which would make the code cleaner and more maintainable. The bug fixes we've applied (buffer encoding + path validation) bring us to feature parity with pasky's version while maintaining our unique OAuth injection capability.

---

**Research Date:** February 28, 2026  
**Gondolin Version:** v0.5.0

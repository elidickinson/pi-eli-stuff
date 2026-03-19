#!/usr/bin/env bash
#
# Replay a benchmark capture against a model.
#
# Usage:
#   ./benchmark-replay.sh <capture-dir> --model <model> [--timeout <secs>]
#
# Example:
#   ./benchmark-replay.sh benchmarks/tricky-auth-bug --model sonnet
#   ./benchmark-replay.sh benchmarks/tricky-auth-bug --model deepseek/deepseek-v3.2 --timeout 300
#
# Batch:
#   for c in benchmarks/*/; do
#     for m in sonnet opus deepseek/deepseek-v3.2; do
#       ./benchmark-replay.sh "$c" --model "$m"
#     done
#   done

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ── Parse args ──

CAPTURE_DIR=""
MODEL=""
TIMEOUT=300

while [[ $# -gt 0 ]]; do
  case "$1" in
    --model) MODEL="$2"; shift 2 ;;
    --timeout) TIMEOUT="$2"; shift 2 ;;
    -*) echo "Unknown flag: $1" >&2; exit 1 ;;
    *) CAPTURE_DIR="$1"; shift ;;
  esac
done

if [[ -z "$CAPTURE_DIR" || -z "$MODEL" ]]; then
  echo "Usage: $0 <capture-dir> --model <model> [--timeout <secs>]" >&2
  exit 1
fi

# Resolve relative to script dir
if [[ ! "$CAPTURE_DIR" = /* ]]; then
  CAPTURE_DIR="$SCRIPT_DIR/$CAPTURE_DIR"
fi

# ── Validate capture ──

CAPTURE_JSON="$CAPTURE_DIR/capture.json"
PROMPT_MD="$CAPTURE_DIR/prompt.md"

if [[ ! -f "$CAPTURE_JSON" ]]; then
  echo "Error: $CAPTURE_JSON not found" >&2
  exit 1
fi

if [[ ! -f "$PROMPT_MD" ]]; then
  echo "Error: $PROMPT_MD not found" >&2
  exit 1
fi

GIT_REF=$(jq -r '.git_ref' "$CAPTURE_JSON")
CWD=$(jq -r '.cwd' "$CAPTURE_JSON")
CAPTURE_NAME=$(basename "$CAPTURE_DIR")

# ── Prepare workspace ──

# Sanitize model name for directory (replace / with -)
MODEL_SAFE=$(echo "$MODEL" | tr '/' '-')
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
RESULT_DIR="$CAPTURE_DIR/results/${MODEL_SAFE}_${TIMESTAMP}"
mkdir -p "$RESULT_DIR"

# Create a temp worktree for the repo
WORK_DIR=$(mktemp -d)
trap 'rm -rf "$WORK_DIR"' EXIT

echo "=== Benchmark Replay ==="
echo "  Capture:   $CAPTURE_NAME"
echo "  Model:     $MODEL"
echo "  Git ref:   $GIT_REF"
echo "  Repo:      $CWD"
echo "  Results:   $RESULT_DIR"
echo ""

# Clone repo at the captured ref
if [[ -d "$CWD/.git" ]]; then
  git clone --quiet "$CWD" "$WORK_DIR/repo"
  cd "$WORK_DIR/repo"
  git checkout --quiet "$GIT_REF" 2>/dev/null || {
    echo "Warning: could not checkout $GIT_REF, using HEAD" >&2
  }
else
  echo "Warning: $CWD is not a git repo, copying directory" >&2
  cp -a "$CWD" "$WORK_DIR/repo"
  cd "$WORK_DIR/repo"
fi

# Apply patch if present
PATCH_FILE="$CAPTURE_DIR/repo.patch"
if [[ -f "$PATCH_FILE" && -s "$PATCH_FILE" ]]; then
  echo "Applying repo.patch..."
  git apply "$PATCH_FILE" || {
    echo "Warning: patch did not apply cleanly" >&2
  }
fi

# ── Run Pi ──

PROMPT=$(cat "$PROMPT_MD")
START_TIME=$(date +%s)

echo "Running pi -p --model $MODEL ..."
echo ""

# Run pi in print mode, capture output
PI_OUTPUT_FILE="$RESULT_DIR/output.txt"
PI_EXIT=0
timeout "$TIMEOUT" pi -p --model "$MODEL" "$PROMPT" > "$PI_OUTPUT_FILE" 2>&1 || PI_EXIT=$?

END_TIME=$(date +%s)
DURATION=$((END_TIME - START_TIME))

# Capture resulting diff
git diff > "$RESULT_DIR/diff.patch" 2>/dev/null || true

# ── Write metadata ──

cat > "$RESULT_DIR/meta.json" <<METAEOF
{
  "capture": "$CAPTURE_NAME",
  "model": "$MODEL",
  "timestamp": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "duration_s": $DURATION,
  "exit_status": $PI_EXIT,
  "timeout": $TIMEOUT,
  "git_ref": "$GIT_REF"
}
METAEOF

echo ""
echo "=== Done ==="
echo "  Duration:  ${DURATION}s"
echo "  Exit:      $PI_EXIT"
echo "  Output:    $RESULT_DIR/output.txt"
echo "  Diff:      $RESULT_DIR/diff.patch"
echo "  Meta:      $RESULT_DIR/meta.json"

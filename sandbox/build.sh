#!/bin/sh
# Build the Gondolin guest image.
#
# 1. Docker builds the rootfs image (cached layers for fast rebuilds)
# 2. Gondolin assembles the VM from the OCI image + Alpine kernel/initramfs
cd "$(dirname "$0")"

set -e

# Generate build info and pass as a build arg so it's baked into the image
BUILD_INFO="Built $(date -u +%Y-%m-%dT%H:%M:%SZ) | $(git -C .. log -1 --format='%h %s')"

docker build --build-arg BUILD_INFO="$BUILD_INFO" -t gondolin-sandbox-base .

gondolin build --config build-config.json --output ./guest-image

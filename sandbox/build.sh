#!/bin/sh
# Build the Gondolin guest image.
#
# build-config.json notes:
#   - npm is reinstalled from tarball because Alpine's bundled npm is too old
#   - pi uses --ignore-scripts because its koffi (FFI) dep needs cmake/gcc
#     to build, and the gondolin postBuild chroot can't link binaries.
#     koffi is only used for terminal/PTY ops which aren't needed in the VM.
cd "$(dirname "$0")"

# Generate build info to bake into the image
BUILD_INFO="Built $(date -u +%Y-%m-%dT%H:%M:%SZ) | $(git -C .. log -1 --format='%h %s')"

# Inject a postBuild command that writes /etc/build-info into the rootfs
jq --arg info "$BUILD_INFO" \
  '.postBuild.commands += ["echo \($info | @json) > /etc/build-info"]' \
  build-config.json > build-config-stamped.json

gondolin build --config build-config-stamped.json --output ./guest-image
rm -f build-config-stamped.json

#!/bin/sh
cd "$(dirname "$0")"

# Generate build info to bake into the image
BUILD_INFO="Built $(date -u +%Y-%m-%dT%H:%M:%SZ) | $(git -C .. log -1 --format='%h %s')"

# Inject a postBuild command that writes /etc/build-info into the rootfs
jq --arg info "$BUILD_INFO" \
  '.postBuild.commands += ["echo \($info | @json) > /etc/build-info"]' \
  build-config.json > build-config-stamped.json

gondolin build --config build-config-stamped.json --output ./my-assets
rm -f build-config-stamped.json

#!/bin/sh
cd "$(dirname "$0")"
gondolin build --config build-config.json --output ./my-assets

#!/bin/bash
# Snap the canonical workspace back onto origin/feature/multichannel-viewer and relaunch :8080.
set -euo pipefail

cd /Users/dm026/Downloads/wsi-server_works
kill -9 $(lsof -t -i:8080) 2>/dev/null || true
git fetch --tags && git reset --hard origin/feature/multichannel-viewer
./mvnw clean package -DskipTests && ./mvnw spring-boot:run

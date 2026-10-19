#!/usr/bin/env bash
# Upload the admin APK to the license server. Skip when the token or URL is unset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${TCGAIO_LICENSE_URL:-}"
TOKEN="${TCGAIO_ADMIN_UPLOAD_TOKEN:-}"
URL="${URL%/}"

if [[ -z "$TOKEN" || -z "$URL" ]]; then
  echo "TCGAIO_ADMIN_UPLOAD_TOKEN or TCGAIO_LICENSE_URL is not set. Skipping the admin APK upload."
  exit 0
fi

APK="$(find "$ROOT/release" -maxdepth 1 -type f -name 'TCGAIO-Admin-*.apk' | head -1)"
if [[ -z "$APK" ]]; then
  echo "No admin APK was built to upload." >&2
  exit 1
fi

VER="$(node -p "require('$ROOT/admin-mobile/package.json').version")"
CODE="$(node -p "require('$ROOT/admin-mobile/app.json').expo.android.versionCode")"
echo "Uploading admin ${VER} (${CODE}) to ${URL}"
curl --fail-with-body --silent --show-error \
  -X POST \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "X-TCGAIO-Version: ${VER}" \
  -H "X-TCGAIO-Version-Code: ${CODE}" \
  -H "Content-Type: application/vnd.android.package-archive" \
  --data-binary @"${APK}" \
  "${URL}/v1/admin/app"
echo
echo "Admin APK uploaded."

#!/usr/bin/env bash
# Upload the admin APK to the license server. Skip when the token or URL is unset.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
URL="${TCGAIO_LICENSE_URL:-}"
URL="${URL%/}"
TOKEN="$(node "$ROOT/scripts/normalize-upload-token.mjs")"

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
NOTES="${TCGAIO_ADMIN_NOTES:-}"
if [[ -z "$NOTES" && -n "${GITHUB_TOKEN:-}" && -n "${GITHUB_REPOSITORY:-}" && -n "${GITHUB_REF_NAME:-}" ]]; then
  NOTES="$(curl --fail --silent --show-error \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/releases/tags/${GITHUB_REF_NAME}" \
    | node -e 'let s="";process.stdin.on("data",c=>s+=c);process.stdin.on("end",()=>{try{const body=JSON.parse(s).body;process.stdout.write(typeof body==="string"?body:"")}catch{}})' || true)"
fi
NOTES="$(printf '%s' "$NOTES" | tr '\n\r' ' ' | sed 's/  */ /g' | cut -c1-500)"
echo "Uploading admin ${VER} (${CODE}) to ${URL}. Token length ${#TOKEN}."
HDR="$(mktemp)"
printf 'Authorization: Bearer %s\nX-TCGAIO-Upload-Token: %s\nX-TCGAIO-Version: %s\nX-TCGAIO-Version-Code: %s\nContent-Type: application/vnd.android.package-archive\n' "$TOKEN" "$TOKEN" "$VER" "$CODE" > "$HDR"
if [[ -n "$NOTES" ]]; then
  printf 'X-TCGAIO-Notes: %s\n' "$NOTES" >> "$HDR"
fi
curl --fail-with-body --silent --show-error \
  -X POST \
  -H @"$HDR" \
  --data-binary @"$APK" \
  "${URL}/v1/admin/app"
rm -f "$HDR"
echo
echo "Admin APK uploaded."

#!/usr/bin/env bash
# Build a standalone release APK with the JS bundle embedded.
set -euo pipefail

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$MOBILE/.." && pwd)"
cd "$MOBILE"

if [[ "${TCGAIO_REQUIRE_LICENSE:-}" == "1" || "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
  LICENSE_ENV="$(mktemp)"
  node "$REPO/scripts/require-license-build.mjs" export-env "$LICENSE_ENV"
  set -a
  # shellcheck disable=SC1090
  source "$LICENSE_ENV"
  set +a
  rm -f "$LICENSE_ENV"
fi

bash "$MOBILE/scripts/prepare-release-signing.sh"
export CI="${CI:-1}"
npx expo prebuild --platform android --no-install --clean --non-interactive
python3 "$MOBILE/scripts/configure-android-release.py"

cd "$MOBILE/android"
chmod +x ./gradlew
./gradlew assembleRelease --no-daemon -PreactNativeArchitectures=armeabi-v7a,arm64-v8a

APK="$MOBILE/android/app/build/outputs/apk/release/app-release.apk"
if [[ ! -f "$APK" ]]; then
  echo "assembleRelease did not write app-release.apk" >&2
  exit 1
fi

python3 - "$APK" <<'PY'
import sys, zipfile
apk = sys.argv[1]
with zipfile.ZipFile(apk) as archive:
    names = archive.namelist()
missing = []
if not any(name == "assets/index.android.bundle" or name.endswith("/assets/index.android.bundle") for name in names):
    missing.append("assets/index.android.bundle")
if not any(name.startswith("lib/arm64-v8a/") for name in names):
    missing.append("lib/arm64-v8a")
if not any(name.startswith("lib/armeabi-v7a/") for name in names):
    missing.append("lib/armeabi-v7a")
if missing:
    sys.exit("Release APK is missing: " + ", ".join(missing))
print("Release APK contains the JS bundle and both ARM ABIs.")
PY

SDK="${ANDROID_SDK_ROOT:-${ANDROID_HOME:-}}"
APKSIGNER=""
if [[ -n "$SDK" ]]; then
  APKSIGNER="$(find "$SDK/build-tools" -type f -name apksigner | sort | tail -1 || true)"
fi
if [[ -n "$APKSIGNER" ]]; then
  CERT="$("$APKSIGNER" verify --verbose --print-certs "$APK")"
  for scheme in v2 v3; do
    if ! printf '%s\n' "$CERT" | grep -q "Verified using $scheme scheme (APK Signature Scheme $scheme): true"; then
      echo "Release APK is not signed with APK Signature Scheme $scheme." >&2
      exit 1
    fi
  done
  AAPT="$(find "$SDK/build-tools" -type f -name aapt2 | sort | tail -1 || true)"
  if [[ -n "$AAPT" ]]; then
    TARGET="$("$AAPT" dump badging "$APK" | grep -o "targetSdkVersion:'[0-9]*'" || true)"
    echo "APK $TARGET"
    [[ "$TARGET" == "targetSdkVersion:'36'" ]] || { echo "Release APK targetSdk is not 36." >&2; exit 1; }
    if "$AAPT" dump badging "$APK" | grep -q "application-debuggable"; then
      echo "Release APK is debuggable." >&2
      exit 1
    fi
  fi
  printf '%s\n' "$CERT" | head -n 20
  # Same key as every APK already installed (0.2.x). A different cert means updates would fail.
  EXPECTED_CERT="${TCGAIO_EXPECTED_CERT_SHA256:-9cd58f8d1d3ec57c1ab164eb0f7b8069394fe4dce73ccd211187a69e81e00afd}"
  if ! printf '%s\n' "$CERT" | grep -q "certificate SHA-256 digest: $EXPECTED_CERT"; then
    if [[ "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
      echo "Release APK signing certificate does not match the published key ($EXPECTED_CERT)." >&2
      exit 1
    fi
    echo "::warning::APK signing certificate differs from the published key (not a tag build)."
  fi
  if printf '%s\n' "$CERT" | grep -qi "CN=Android Debug"; then
    echo "Release APK is still signed with the Android debug certificate." >&2
    exit 1
  fi
fi

# package.json lives in mobile/, and gradle left us in mobile/android.
cd "$MOBILE"
VER="$(node -p "require('./package.json').version")"
mkdir -p "$REPO/release"
cp "$APK" "$REPO/release/TCGAIO-Admin-${VER}.apk"
if [[ "${TCGAIO_REQUIRE_LICENSE:-}" == "1" || "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
  BUNDLE_DIR="$(mktemp -d)"
  python3 - "$APK" "$BUNDLE_DIR/index.android.bundle" <<'PY'
import sys
import zipfile
from pathlib import Path
apk, dest = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(apk) as archive:
    name = next((item for item in archive.namelist() if item.endswith("index.android.bundle")), None)
    if not name:
        sys.exit("Release APK has no JS bundle to check for the license server.")
    Path(dest).write_bytes(archive.read(name))
PY
  node "$REPO/scripts/require-license-build.mjs" verify "$BUNDLE_DIR"
fi
echo "Wrote $REPO/release/TCGAIO-Admin-${VER}.apk"

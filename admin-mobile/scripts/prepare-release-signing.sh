#!/usr/bin/env bash
# Resolve the release keystore without printing passwords.
# Order: Actions secrets, a previous Actions artifact, the agent store, files already in admin-mobile/.
set -euo pipefail

MOBILE="$(cd "$(dirname "$0")/.." && pwd)"
KS="$MOBILE/release.keystore"
PROPS="$MOBILE/keystore.properties"
ORIGIN="$MOBILE/.keystore-origin"
umask 077

write_props() {
  local file="$1" pass="$2" alias="$3" keypass="$4" origin="$5"
  cat > "$PROPS" <<EOF
storeFile=${file}
storePassword=${pass}
keyAlias=${alias}
keyPassword=${keypass}
EOF
  chmod 600 "$KS" "$PROPS"
  printf '%s\n' "$origin" > "$ORIGIN"
  chmod 600 "$ORIGIN"
}

copy_store() {
  local dir="$1" origin="$2"
  local pass alias keypass
  pass="$(grep '^storePassword=' "$dir/keystore.properties" | cut -d= -f2-)"
  alias="$(grep '^keyAlias=' "$dir/keystore.properties" | cut -d= -f2-)"
  keypass="$(grep '^keyPassword=' "$dir/keystore.properties" | cut -d= -f2-)"
  cp "$dir/tcgaio-release.keystore" "$KS"
  write_props "$KS" "$pass" "$alias" "$keypass" "$origin"
}

if [[ -n "${ANDROID_KEYSTORE_BASE64:-}" ]]; then
  : "${ANDROID_KEYSTORE_PASSWORD:?ANDROID_KEYSTORE_PASSWORD is required with ANDROID_KEYSTORE_BASE64}"
  : "${ANDROID_KEY_ALIAS:?ANDROID_KEY_ALIAS is required with ANDROID_KEYSTORE_BASE64}"
  : "${ANDROID_KEY_PASSWORD:?ANDROID_KEY_PASSWORD is required with ANDROID_KEYSTORE_BASE64}"
  printf '%s' "$ANDROID_KEYSTORE_BASE64" | base64 -d > "$KS"
  write_props "$KS" "$ANDROID_KEYSTORE_PASSWORD" "$ANDROID_KEY_ALIAS" "$ANDROID_KEY_PASSWORD" secret
  echo "Using the release keystore from Actions secrets."
  exit 0
fi

if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
  set +e
  python3 "$MOBILE/scripts/restore-keystore-artifact.py"
  restore_status=$?
  set -e
  if [[ "$restore_status" -eq 0 ]]; then
    exit 0
  fi
  if [[ "$restore_status" -ne 2 ]]; then
    echo "The saved release keystore could not be downloaded. Refusing to mint a different key." >&2
    exit 1
  fi
fi

for dir in /cursor/stores/self/tcgaio-android-release /cursor/stores/bot/tcgaio-android-release; do
  if [[ -f "$dir/tcgaio-release.keystore" && -f "$dir/keystore.properties" ]]; then
    copy_store "$dir" store
    echo "Using the release keystore stored outside the repo."
    exit 0
  fi
done

if [[ -f "$KS" && -f "$PROPS" ]]; then
  echo "Using the release keystore already in admin-mobile/."
  if [[ ! -f "$ORIGIN" ]]; then
    printf 'local\n' > "$ORIGIN"
    chmod 600 "$ORIGIN"
  fi
  exit 0
fi

if [[ "${TCGAIO_GENERATE_KEYSTORE:-}" == "1" ]]; then
  if [[ "${GITHUB_REF_TYPE:-}" == "tag" && "${TCGAIO_ALLOW_NEW_KEYSTORE:-}" != "1" ]]; then
    echo "Refusing to mint a new signing key for a tagged release. Updates would fail with a signature mismatch. Set ANDROID_KEYSTORE_BASE64, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, and ANDROID_KEY_PASSWORD to the keystore that signed the installed APK." >&2
    exit 1
  fi
  PASS="$(openssl rand -hex 24)"
  keytool -genkeypair -v \
    -keystore "$KS" \
    -alias tcgaio \
    -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass "$PASS" -keypass "$PASS" \
    -dname "CN=TCGAIO Admin, OU=TCGAIO, O=TCGAIO, C=US" >/dev/null 2>&1
  if [[ "${GITHUB_REF_TYPE:-}" == "tag" ]]; then
    ORIGIN_NAME="generated"
  else
    ORIGIN_NAME="ephemeral"
  fi
  write_props "$KS" "$PASS" tcgaio "$PASS" "$ORIGIN_NAME"
  echo "Generated a new release keystore ($ORIGIN_NAME)."
  exit 0
fi

echo "No release keystore. Set the ANDROID_KEYSTORE_* Actions secrets, or place admin-mobile/release.keystore and admin-mobile/keystore.properties." >&2
exit 1

#!/usr/bin/env python3
"""Restore the release keystore uploaded by a previous GitHub Actions run."""

import json
import os
import sys
import urllib.error
import urllib.request
import zipfile
from io import BytesIO
from pathlib import Path

token = os.environ.get("GITHUB_TOKEN") or os.environ.get("GH_TOKEN")
repo = os.environ.get("GITHUB_REPOSITORY")
if not token or not repo:
    sys.exit(2)

mobile = Path(__file__).resolve().parents[1]
headers = {
    "Authorization": f"Bearer {token}",
    "Accept": "application/vnd.github+json",
    "User-Agent": "tcgaio-release-signing",
    "X-GitHub-Api-Version": "2022-11-28",
}


def get(url: str) -> bytes:
    request = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(request) as response:
            return response.read()
    except urllib.error.HTTPError as err:
        if err.code == 404:
            sys.exit(2)
        sys.exit(1)


listing = json.loads(
    get(f"https://api.github.com/repos/{repo}/actions/artifacts?name=tcgaio-release-keystore&per_page=100")
)
artifacts = [
    item
    for item in listing.get("artifacts", [])
    if item.get("name") == "tcgaio-release-keystore" and not item.get("expired")
]
if not artifacts:
    sys.exit(2)

chosen = sorted(artifacts, key=lambda item: item["created_at"])[-1]
blob = get(f"https://api.github.com/repos/{repo}/actions/artifacts/{chosen['id']}/zip")
with zipfile.ZipFile(BytesIO(blob)) as archive:
    names = archive.namelist()
    keystore_name = next((name for name in names if name.endswith("release.keystore")), None)
    props_name = next((name for name in names if name.endswith("keystore.properties")), None)
    if not keystore_name or not props_name:
        sys.exit(2)
    keystore_bytes = archive.read(keystore_name)
    props_text = archive.read(props_name).decode()

values = {}
for line in props_text.splitlines():
    if "=" in line:
        key, value = line.split("=", 1)
        values[key.strip()] = value

password = values.get("storePassword")
alias = values.get("keyAlias")
key_password = values.get("keyPassword")
if not password or not alias or not key_password:
    sys.exit(2)

keystore_path = mobile / "release.keystore"
keystore_path.write_bytes(keystore_bytes)
props_path = mobile / "keystore.properties"
props_path.write_text(
    f"storeFile={keystore_path}\nstorePassword={password}\nkeyAlias={alias}\nkeyPassword={key_password}\n"
)
os.chmod(keystore_path, 0o600)
os.chmod(props_path, 0o600)
(mobile / ".keystore-origin").write_text("artifact\n")
print("Restored the release keystore from the previous build.")

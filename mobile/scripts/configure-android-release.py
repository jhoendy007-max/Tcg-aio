#!/usr/bin/env python3
"""Pin the prebuild Android project to a signed release with both phone ABIs."""

from pathlib import Path
import json
import re
import sys

mobile = Path(__file__).resolve().parents[1]
gradle_properties = mobile / "android" / "gradle.properties"
app_gradle = mobile / "android" / "app" / "build.gradle"

if not gradle_properties.exists() or not app_gradle.exists():
    sys.exit("expo prebuild did not create android/app. Run prebuild before this script.")

properties = gradle_properties.read_text()
replacements = {
    "reactNativeArchitectures": "armeabi-v7a,arm64-v8a",
    "android.enableMinifyInReleaseBuilds": "false",
    "android.enableShrinkResourcesInReleaseBuilds": "false",
    # 0.2.37: pin the latest stable target (Android 16 / API 36), matching the Expo 58 default.
    "android.targetSdkVersion": "36",
}
for key, value in replacements.items():
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    line = f"{key}={value}"
    properties = pattern.sub(line, properties) if pattern.search(properties) else properties + f"\n{line}\n"
if "org.gradle.jvmargs=" in properties:
    properties = re.sub(
        r"^org.gradle.jvmargs=.*$",
        "org.gradle.jvmargs=-Xmx3072m -XX:MaxMetaspaceSize=512m",
        properties,
        count=1,
        flags=re.MULTILINE,
    )
gradle_properties.write_text(properties)

manifest_path = mobile / "android" / "app" / "src" / "main" / "AndroidManifest.xml"
manifest = manifest_path.read_text()
if "usesCleartextTraffic" not in manifest:
    manifest = manifest.replace(
        "<application ",
        '<application android:usesCleartextTraffic="true" ',
        1,
    )
    manifest_path.write_text(manifest)

gradle = app_gradle.read_text()
if "TCGAIO_RELEASE_SIGNING" not in gradle:
    release_config = """
        release {
            // TCGAIO_RELEASE_SIGNING reads mobile/keystore.properties (not committed).
            def keystoreProperties = new Properties()
            def keystorePropertiesFile = rootProject.file("../keystore.properties")
            if (!keystorePropertiesFile.exists()) {
                throw new GradleException("mobile/keystore.properties is missing. Run mobile/scripts/prepare-release-signing.sh")
            }
            keystoreProperties.load(new FileInputStream(keystorePropertiesFile))
            storeFile file(keystoreProperties['storeFile'])
            storePassword keystoreProperties['storePassword']
            keyAlias keystoreProperties['keyAlias']
            keyPassword keystoreProperties['keyPassword']
            // 0.2.37: APK Signature Scheme v2 + v3 (v3 allows key rotation later).
            enableV1Signing true
            enableV2Signing true
            enableV3Signing true
        }
"""
    needle = "            keyPassword 'android'\n        }\n    }\n    buildTypes {"
    replacement = "            keyPassword 'android'\n        }\n" + release_config + "    }\n    buildTypes {"
    if needle not in gradle:
        sys.exit("app/build.gradle signingConfigs block was not the Expo template this script knows.")
    gradle = gradle.replace(needle, replacement, 1)
    release_type = """        release {
            // Caution! In production, you need to generate your own keystore file.
            // see https://reactnative.dev/docs/signed-apk-android.
            signingConfig signingConfigs.debug
"""
    signed = """        release {
            // TCGAIO_RELEASE_SIGNING
            signingConfig signingConfigs.release
"""
    if release_type not in gradle:
        sys.exit("app/build.gradle release build type was not the Expo template this script knows.")
    gradle = gradle.replace(release_type, signed, 1)
    app_gradle.write_text(gradle)

package = json.loads((mobile / "package.json").read_text())
parts = [int(part) for part in str(package["version"]).split(".")[:3]]
while len(parts) < 3:
    parts.append(0)
code = parts[0] * 10000 + parts[1] * 100 + parts[2]
gradle = app_gradle.read_text()
gradle = re.sub(r"versionCode \d+", f"versionCode {code}", gradle, count=1)
gradle = re.sub(r'versionName "[^"]*"', f'versionName "{package["version"]}"', gradle, count=1)
app_gradle.write_text(gradle)
print(f"Configured Android release signing, ABIs, versionCode {code}, and the embedded bundle build.")

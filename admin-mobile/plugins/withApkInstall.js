const { withAndroidManifest } = require("@expo/config-plugins")

/** Let Android 11+ see the package installer so the APK view intent can open. */
function withApkInstall(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest
    const queries = Array.isArray(manifest.queries) ? manifest.queries : []
    queries.push({
      intent: [{
        action: [{ $: { "android:name": "android.intent.action.VIEW" } }],
        data: [{ $: { "android:mimeType": "application/vnd.android.package-archive" } }]
      }]
    })
    manifest.queries = queries
    return config
  })
}

module.exports = withApkInstall

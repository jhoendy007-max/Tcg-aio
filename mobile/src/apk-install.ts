import * as FileSystem from "expo-file-system/legacy"
import * as IntentLauncher from "expo-intent-launcher"

export async function downloadApk(url: string, onProgress: (percent: number) => void): Promise<string> {
  const dest = `${FileSystem.cacheDirectory ?? ""}tcgaio-update.apk`
  await FileSystem.deleteAsync(dest, { idempotent: true }).catch(() => undefined)
  const task = FileSystem.createDownloadResumable(url, dest, {}, (progress) => {
    const total = progress.totalBytesExpectedToWrite
    onProgress(total > 0 ? (progress.totalBytesWritten / total) * 100 : 0)
  })
  const result = await task.downloadAsync()
  if (!result?.uri) throw new Error("The APK download did not finish.")
  return result.uri
}

export async function openApkInstaller(uri: string): Promise<void> {
  const content = await FileSystem.getContentUriAsync(uri)
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: content,
    flags: 1,
    type: "application/vnd.android.package-archive"
  })
}

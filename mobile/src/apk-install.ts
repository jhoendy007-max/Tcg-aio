import { apkInstaller } from "../modules/zzz-apk-installer"
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

/** True when Android lets this app install updates; false means the one-time "Install unknown apps" switch is off. */
export function canInstallUpdates(): boolean {
  try { return apkInstaller ? apkInstaller.canRequestInstalls() : true } catch { return true }
}

export function openInstallSettings(): void {
  apkInstaller?.openInstallSettings()
}

/** 0.2.37: PackageInstaller session (native module), falling back to the system APK viewer on old builds. */
export async function openApkInstaller(uri: string): Promise<void> {
  if (apkInstaller) {
    await apkInstaller.install(uri)
    return
  }
  const content = await FileSystem.getContentUriAsync(uri)
  await IntentLauncher.startActivityAsync("android.intent.action.VIEW", {
    data: content,
    flags: 1,
    type: "application/vnd.android.package-archive"
  })
}

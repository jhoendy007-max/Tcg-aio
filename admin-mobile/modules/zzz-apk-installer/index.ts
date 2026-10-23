import { requireOptionalNativeModule } from "expo"

interface ZzzApkInstaller {
  canRequestInstalls(): boolean
  openInstallSettings(): void
  install(path: string): Promise<"installed" | "cancelled">
}

/** Null in Expo Go or an older build without the module; callers fall back to the ACTION_VIEW installer. */
export const apkInstaller = requireOptionalNativeModule<ZzzApkInstaller>("ZzzApkInstaller")

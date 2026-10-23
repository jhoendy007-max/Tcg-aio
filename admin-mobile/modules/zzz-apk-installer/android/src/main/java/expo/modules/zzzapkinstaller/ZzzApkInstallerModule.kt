package expo.modules.zzzapkinstaller

import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageInstaller
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.ContextCompat
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

/**
 * Self-update through a PackageInstaller session (the supported replacement for ACTION_VIEW on an APK).
 * Android still shows its own confirm sheet unless the app is the installer of record on Android 12+.
 */
class ZzzApkInstallerModule : Module() {
  private val context: Context
    get() = appContext.reactContext ?: throw CodedException("ERR_NO_CONTEXT", "Android context is not ready.", null)

  override fun definition() = ModuleDefinition {
    Name("ZzzApkInstaller")

    Function("canRequestInstalls") {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) true else context.packageManager.canRequestPackageInstalls()
    }

    Function("openInstallSettings") {
      val intent = Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${context.packageName}"))
      intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      context.startActivity(intent)
    }

    AsyncFunction("install") { path: String, promise: Promise ->
      try {
        install(File(path.removePrefix("file://")), promise)
      } catch (error: Throwable) {
        promise.reject(CodedException("ERR_INSTALL", error.message ?: "The update could not be installed.", error))
      }
    }
  }

  private fun install(apk: File, promise: Promise) {
    if (!apk.isFile) throw IllegalArgumentException("The downloaded APK is missing.")
    val ctx = context
    val installer = ctx.packageManager.packageInstaller
    val params = PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL)
    params.setAppPackageName(ctx.packageName)
    params.setSize(apk.length())
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
      params.setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)
    }
    val sessionId = installer.createSession(params)
    val action = "${ctx.packageName}.ZZZ_APK_INSTALL.$sessionId"
    val receiver = object : BroadcastReceiver() {
      override fun onReceive(receiverContext: Context, intent: Intent) {
        when (val status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE)) {
          PackageInstaller.STATUS_PENDING_USER_ACTION -> {
            @Suppress("DEPRECATION")
            val confirm = if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent::class.java) else intent.getParcelableExtra(Intent.EXTRA_INTENT)
            confirm?.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            if (confirm != null) receiverContext.startActivity(confirm)
          }
          PackageInstaller.STATUS_SUCCESS -> {
            runCatching { receiverContext.unregisterReceiver(this) }
            promise.resolve("installed")
          }
          else -> {
            runCatching { receiverContext.unregisterReceiver(this) }
            val message = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE) ?: "Install failed ($status)."
            if (status == PackageInstaller.STATUS_FAILURE_ABORTED) promise.resolve("cancelled")
            else promise.reject(CodedException("ERR_INSTALL_$status", message, null))
          }
        }
      }
    }
    ContextCompat.registerReceiver(ctx, receiver, IntentFilter(action), ContextCompat.RECEIVER_NOT_EXPORTED)
    installer.openSession(sessionId).use { session ->
      apk.inputStream().use { input ->
        session.openWrite("update.apk", 0, apk.length()).use { output ->
          input.copyTo(output)
          session.fsync(output)
        }
      }
      val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) PendingIntent.FLAG_MUTABLE else 0)
      val callback = PendingIntent.getBroadcast(ctx, sessionId, Intent(action).setPackage(ctx.packageName), flags)
      session.commit(callback.intentSender)
    }
  }
}

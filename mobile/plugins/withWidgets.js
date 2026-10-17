const fs = require("fs")
const path = require("path")
const { withAndroidManifest, withDangerousMod, withMainApplication } = require("@expo/config-plugins")

const WIDGET = `package com.tcgaio.phone

import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.Context
import android.widget.RemoteViews

class TCGAIOWidget : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
    val prefs = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
    val wins = prefs.getInt("wins", 0)
    val active = prefs.getInt("active", 0)
    for (id in ids) manager.updateAppWidget(id, views(context, wins, active))
  }

  companion object {
    const val PREFS = "tcgaio_widget"

    fun views(context: Context, wins: Int, active: Int): RemoteViews {
      val views = RemoteViews(context.packageName, R.layout.widget_tcgaio)
      views.setTextViewText(R.id.widget_wins, wins.toString())
      views.setTextViewText(R.id.widget_active, active.toString())
      return views
    }
  }
}
`

const MODULE = `package com.tcgaio.phone

import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Context
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class WidgetModule(private val reactContext: ReactApplicationContext) : ReactContextBaseJavaModule(reactContext) {
  override fun getName() = "TCGAIOWidget"

  @ReactMethod
  fun update(wins: Int, active: Int) {
    val prefs = reactContext.getSharedPreferences(TCGAIOWidget.PREFS, Context.MODE_PRIVATE)
    prefs.edit().putInt("wins", wins).putInt("active", active).apply()
    val manager = AppWidgetManager.getInstance(reactContext)
    val ids = manager.getAppWidgetIds(ComponentName(reactContext, TCGAIOWidget::class.java))
    for (id in ids) manager.updateAppWidget(id, TCGAIOWidget.views(reactContext, wins, active))
  }
}
`

const PACKAGE = `package com.tcgaio.phone

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

class WidgetPackage : ReactPackage {
  override fun createNativeModules(reactContext: ReactApplicationContext): List<NativeModule> =
    listOf(WidgetModule(reactContext))

  override fun createViewManagers(reactContext: ReactApplicationContext): List<ViewManager<*, *>> =
    emptyList()
}
`

const LAYOUT = `<?xml version="1.0" encoding="utf-8"?>
<LinearLayout xmlns:android="http://schemas.android.com/apk/res/android"
  android:layout_width="match_parent"
  android:layout_height="match_parent"
  android:background="#14161b"
  android:gravity="center_vertical"
  android:orientation="horizontal"
  android:padding="12dp">
  <LinearLayout android:layout_width="0dp" android:layout_height="wrap_content" android:layout_weight="1" android:orientation="vertical">
    <TextView android:id="@+id/widget_wins" android:text="0" android:textColor="#e0b15a" android:textSize="22sp" android:textStyle="bold" />
    <TextView android:text="Wins" android:textColor="#9aa3b5" android:textSize="12sp" />
  </LinearLayout>
  <LinearLayout android:layout_width="0dp" android:layout_height="wrap_content" android:layout_weight="1" android:orientation="vertical">
    <TextView android:id="@+id/widget_active" android:text="0" android:textColor="#e7ebf2" android:textSize="22sp" android:textStyle="bold" />
    <TextView android:text="Active" android:textColor="#9aa3b5" android:textSize="12sp" />
  </LinearLayout>
</LinearLayout>
`

const INFO = `<?xml version="1.0" encoding="utf-8"?>
<appwidget-provider xmlns:android="http://schemas.android.com/apk/res/android"
  android:minWidth="180dp"
  android:minHeight="80dp"
  android:updatePeriodMillis="1800000"
  android:initialLayout="@layout/widget_tcgaio"
  android:resizeMode="horizontal|vertical"
  android:widgetCategory="home_screen"
  android:description="@string/widget_tcgaio_desc" />
`

const STRINGS = `<?xml version="1.0" encoding="utf-8"?>
<resources>
  <string name="widget_tcgaio_desc">Wins and tasks that are running.</string>
</resources>
`

function writeWidgets(root) {
  const javaDir = path.join(root, "app/src/main/java/com/tcgaio/phone")
  fs.mkdirSync(javaDir, { recursive: true })
  fs.writeFileSync(path.join(javaDir, "TCGAIOWidget.kt"), WIDGET)
  fs.writeFileSync(path.join(javaDir, "WidgetModule.kt"), MODULE)
  fs.writeFileSync(path.join(javaDir, "WidgetPackage.kt"), PACKAGE)
  const layout = path.join(root, "app/src/main/res/layout")
  const xml = path.join(root, "app/src/main/res/xml")
  const values = path.join(root, "app/src/main/res/values")
  fs.mkdirSync(layout, { recursive: true })
  fs.mkdirSync(xml, { recursive: true })
  fs.mkdirSync(values, { recursive: true })
  fs.writeFileSync(path.join(layout, "widget_tcgaio.xml"), LAYOUT)
  fs.writeFileSync(path.join(xml, "widget_tcgaio_info.xml"), INFO)
  fs.writeFileSync(path.join(values, "tcgaio_widget.xml"), STRINGS)
}

function insertPackage(contents) {
  if (contents.includes("WidgetPackage()")) return contents
  const markers = ["// add(MyReactNativePackage())", "// add(MyReactPackage())", "PackageList(this).packages.apply {"]
  for (const marker of markers) {
    if (!contents.includes(marker)) continue
    return contents.replace(marker, `${marker}\n              add(WidgetPackage())`)
  }
  throw new Error(`TCGAIO widget plugin could not find the PackageList block in MainApplication.\\n${contents.slice(0, 900)}`)
}

function withWidgets(config) {
  config = withDangerousMod(config, ["android", async (cfg) => {
    writeWidgets(cfg.modRequest.platformProjectRoot)
    return cfg
  }])
  config = withAndroidManifest(config, (cfg) => {
    const app = cfg.modResults.manifest.application && cfg.modResults.manifest.application[0]
    if (!app) throw new Error("Android manifest has no application tag.")
    if (!app.receiver) app.receiver = []
    const name = ".TCGAIOWidget"
    const exists = app.receiver.some((item) => item.$ && item.$["android:name"] === name)
    if (!exists) {
      app.receiver.push({
        $: { "android:name": name, "android:exported": "false" },
        "intent-filter": [{ action: [{ $: { "android:name": "android.appwidget.action.APPWIDGET_UPDATE" } }] }],
        "meta-data": [{ $: { "android:name": "android.appwidget.provider", "android:resource": "@xml/widget_tcgaio_info" } }]
      })
    }
    return cfg
  })
  config = withMainApplication(config, (cfg) => {
    const file = cfg.modResults
    const contents = typeof file === "string" ? file : file.contents
    const next = insertPackage(contents)
    if (typeof file === "string") cfg.modResults = next
    else file.contents = next
    return cfg
  })
  return config
}

module.exports = withWidgets

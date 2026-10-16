import { app } from "electron"
import { autoUpdater } from "electron-updater"
import type { Database } from "../engine/database"
import { defaultHttp } from "../engine/http"
import { compareVersions, fetchLatestRelease } from "../engine/releases"
import { RELEASE_OWNER, RELEASE_REPO, APP_VERSION } from "../shared/version"
import type { UpdateStatus } from "../shared/types"

export interface UpdateController {
  current(): UpdateStatus
  check(): Promise<UpdateStatus>
  download(): Promise<UpdateStatus>
  install(): void
}

export function createUpdateController(db: Database, emit: (status: UpdateStatus) => void): UpdateController {
  let state = idle(db)
  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.allowPrerelease = true
  autoUpdater.on("update-downloaded", () => {
    state = { ...state, status: "downloaded", error: "" }
    emit(publicState(state))
  })
  autoUpdater.on("error", (err) => {
    const message = err instanceof Error ? err.message : "The update could not be downloaded."
    state = { ...state, status: "error", error: message.replace(/gh[ps]_[A-Za-z0-9_]+/g, "[token]") }
    emit(publicState(state))
  })

  function current(): UpdateStatus {
    return publicState({ ...state, hasToken: db.hasUpdateToken(), current: APP_VERSION })
  }

  async function check(): Promise<UpdateStatus> {
    state = { ...current(), status: "checking", error: "" }
    emit(publicState(state))
    try {
      const release = await fetchLatestRelease(defaultHttp, db.updateToken())
      const version = release?.version ?? null
      const notes = release?.notes ?? ""
      const phoneVersion = release?.apk ? version : null
      db.saveUpdateNotice({ desktopVersion: version, phoneVersion, notes })
      const newer = Boolean(version && compareVersions(version, APP_VERSION) > 0 && release?.exe)
      state = {
        ...current(),
        status: newer ? "available" : "current",
        version: newer ? version : APP_VERSION,
        notes,
        phoneVersion,
        error: ""
      }
      if (newer && app.isPackaged) {
        autoUpdater.setFeedURL({
          provider: "github",
          owner: RELEASE_OWNER,
          repo: RELEASE_REPO,
          private: true,
          token: db.updateToken()
        })
        await autoUpdater.checkForUpdates()
      }
    } catch (err) {
      state = { ...current(), status: "error", error: err instanceof Error ? err.message : "The update check failed." }
    }
    emit(publicState(state))
    return publicState(state)
  }

  async function download(): Promise<UpdateStatus> {
    if (!app.isPackaged) {
      state = { ...current(), status: "error", error: "Install the Windows app to download an update. This check only reports that a release exists." }
      emit(publicState(state))
      return publicState(state)
    }
    state = { ...current(), status: "downloading", error: "" }
    emit(publicState(state))
    await autoUpdater.downloadUpdate()
    return publicState(state)
  }

  function install(): void {
    autoUpdater.quitAndInstall()
  }

  return { current, check, download, install }
}

function idle(db: Database): UpdateStatus {
  return {
    current: APP_VERSION,
    status: "idle",
    version: null,
    notes: "",
    phoneVersion: null,
    error: "",
    hasToken: db.hasUpdateToken()
  }
}

function publicState(status: UpdateStatus): UpdateStatus {
  return { ...status }
}

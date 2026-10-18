import { app } from "electron"
import { autoUpdater } from "electron-updater"
import type { Database } from "../engine/database"
import { defaultHttp } from "../engine/http"
import { fetchLatestRelease } from "../engine/releases"
import { applyProgress, canInstall, feedPrivacy, markFailed, markReady, releaseDecision, startChecking, startDownload } from "../engine/update-flow"
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
  autoUpdater.on("download-progress", (progress) => {
    state = applyProgress(state, progress.percent)
    emit(publicState(state))
  })
  autoUpdater.on("update-downloaded", () => {
    state = markReady(state)
    emit(publicState(state))
  })
  autoUpdater.on("error", (err) => {
    state = markFailed(state, err instanceof Error ? err.message : "The update could not be downloaded.")
    emit(publicState(state))
  })

  function current(): UpdateStatus {
    return publicState({ ...state, hasToken: db.hasUpdateToken(), current: APP_VERSION })
  }

  async function check(): Promise<UpdateStatus> {
    state = startChecking(current())
    emit(publicState(state))
    try {
      const release = await fetchLatestRelease(defaultHttp, db.updateToken())
      const version = release?.version ?? null
      const phoneVersion = release?.apk ? version : null
      db.saveUpdateNotice({ desktopVersion: version, phoneVersion, notes: release?.notes ?? "" })
      state = releaseDecision(current(), release, APP_VERSION)
      if (state.status === "available" && app.isPackaged) {
        const feed = feedPrivacy(db.updateToken())
        autoUpdater.setFeedURL({
          provider: "github",
          owner: RELEASE_OWNER,
          repo: RELEASE_REPO,
          private: feed.private,
          ...(feed.token ? { token: feed.token } : {})
        })
        await autoUpdater.checkForUpdates()
      }
    } catch (err) {
      state = markFailed(current(), err instanceof Error ? err.message : "The update check failed.")
    }
    emit(publicState(state))
    return publicState(state)
  }

  async function download(): Promise<UpdateStatus> {
    const next = startDownload(current(), app.isPackaged)
    state = next.status
    emit(publicState(state))
    if (!next.proceed) return publicState(state)
    try {
      await autoUpdater.downloadUpdate()
      if (state.status === "downloading") {
        state = markReady(state)
        emit(publicState(state))
      }
    } catch (err) {
      if (state.status !== "error") {
        state = markFailed(state, err instanceof Error ? err.message : "The update could not be downloaded.")
        emit(publicState(state))
      }
    }
    return publicState(state)
  }

  function install(): void {
    const decision = canInstall(current(), app.isPackaged)
    if (!decision.ok) {
      state = decision.status
      emit(publicState(state))
      throw new Error(decision.status.error)
    }
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
    hasToken: db.hasUpdateToken(),
    percent: null
  }
}

function publicState(status: UpdateStatus): UpdateStatus {
  return { ...status }
}

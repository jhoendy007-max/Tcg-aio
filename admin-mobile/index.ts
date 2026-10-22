import { createElement } from "react"
import { registerRootComponent } from "expo"
import App from "./App"
import { AppErrorBoundary } from "./ErrorBoundary"
import { keepLicenseBuild } from "./license-build"

keepLicenseBuild()

function Root() {
  return createElement(AppErrorBoundary, null, createElement(App))
}

registerRootComponent(Root)

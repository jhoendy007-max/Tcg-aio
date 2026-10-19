import "react-native-get-random-values"
import { createElement } from "react"
import { registerRootComponent } from "expo"
import App from "./App"
import { AppErrorBoundary } from "./src/ErrorBoundary"
import { keepLicenseBuild } from "./src/license-build"

keepLicenseBuild()
function Root() {
  return createElement(AppErrorBoundary, null, createElement(App))
}
registerRootComponent(Root)

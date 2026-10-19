import { createElement } from "react"
import { registerRootComponent } from "expo"
import App from "./App"
import { AppErrorBoundary } from "./ErrorBoundary"

function Root() {
  return createElement(AppErrorBoundary, null, createElement(App))
}

registerRootComponent(Root)

import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { App } from "./App"
import { AppErrorBoundary } from "./ErrorBoundary"
import "./styles.css"

const root = document.getElementById("root")
if (!root) throw new Error("Root element missing.")
createRoot(root).render(
  <StrictMode>
    <AppErrorBoundary><App /></AppErrorBoundary>
  </StrictMode>
)

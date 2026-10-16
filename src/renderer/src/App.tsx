import { useEffect, useState } from "react"
import { AccountsPage } from "./pages/Accounts"
import { ProfilesPage } from "./pages/Profiles"
import { ProxiesPage } from "./pages/Proxies"
import { SettingsPage } from "./pages/Settings"
import { TasksPage } from "./pages/Tasks"

const PAGES = [
  { id: "tasks", label: "Tasks" },
  { id: "profiles", label: "Profiles" },
  { id: "proxies", label: "Proxies" },
  { id: "accounts", label: "Accounts" },
  { id: "settings", label: "Settings" }
] as const

type PageId = (typeof PAGES)[number]["id"]

function pageFromHash(): PageId {
  const hash = window.location.hash.replace("#", "")
  return PAGES.some((page) => page.id === hash) ? (hash as PageId) : "tasks"
}

export function App() {
  const [page, setPage] = useState<PageId>(pageFromHash)

  useEffect(() => {
    const onHash = () => setPage(pageFromHash())
    window.addEventListener("hashchange", onHash)
    return () => window.removeEventListener("hashchange", onHash)
  }, [])

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Mark />
          <div>
            <strong>TCGAIO</strong>
            <span>Pokémon · One Piece</span>
          </div>
        </div>
        <nav>
          {PAGES.map((item) => (
            <a key={item.id} href={`#${item.id}`} aria-current={page === item.id ? "page" : undefined}>
              {item.label}
            </a>
          ))}
        </nav>
        <footer>
          <span>v0.1.0</span>
          <span>Target shipping checkout</span>
        </footer>
      </aside>
      <main>
        {page === "tasks" ? <TasksPage /> : null}
        {page === "profiles" ? <ProfilesPage /> : null}
        {page === "proxies" ? <ProxiesPage /> : null}
        {page === "accounts" ? <AccountsPage /> : null}
        {page === "settings" ? <SettingsPage /> : null}
      </main>
    </div>
  )
}

function Mark() {
  return (
    <svg className="mark" viewBox="0 0 32 32" aria-hidden="true">
      <rect x="1" y="1" width="30" height="30" rx="7" />
      <path d="M9 22.5 16 8l7 14.5H9z" />
    </svg>
  )
}

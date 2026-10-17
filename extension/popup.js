const STORE_NAMES = {
  target: "Target",
  walmart: "Walmart",
  bestbuy: "Best Buy",
  "pokemon-center": "Pokémon Center",
  amazon: "Amazon",
  crunchyroll: "Crunchyroll",
  bandai: "Premium Bandai"
}

const pairSection = document.querySelector("#pair")
const linkedSection = document.querySelector("#linked")
const errorNode = document.querySelector("#error")
const pcNode = document.querySelector("#pc")
const list = document.querySelector("#accounts")
const code = document.querySelector("#code")

function showError(text) {
  errorNode.hidden = !text
  errorNode.textContent = text || ""
}

function ask(message) {
  return chrome.runtime.sendMessage(message)
}

function render(state) {
  if (!state?.ok && state?.error) showError(state.error)
  else showError(state?.error || "")
  const paired = Boolean(state?.paired)
  pairSection.hidden = paired
  linkedSection.hidden = !paired
  pcNode.textContent = paired ? `${state.online ? "Connected" : "Offline"} · ${state.pcName || "PC"}` : "Not paired"
  list.replaceChildren()
  for (const account of state?.accounts || []) {
    const link = (state.links || []).find((item) => item.accountId === account.id)
    const sync = state.sync?.[account.id]
    const item = document.createElement("li")
    const title = document.createElement("strong")
    title.textContent = `${STORE_NAMES[account.store] || account.store} · ${account.label}`
    const meta = document.createElement("div")
    meta.className = "meta"
    meta.textContent = link
      ? `${link.twoWay ? "Two-way on" : "One-way"}${sync?.error ? ` · ${sync.error}` : sync?.at ? " · Synced" : ""}`
      : "Not linked"
    const actions = document.createElement("div")
    actions.className = "actions"
    if (!link) {
      actions.append(button("Link", () => run({ op: "link", accountId: account.id, twoWay: false })))
    } else {
      const toggle = document.createElement("label")
      const box = document.createElement("input")
      box.type = "checkbox"
      box.checked = link.twoWay
      box.addEventListener("change", () => run({ op: "link", accountId: account.id, twoWay: box.checked }))
      toggle.append(box, document.createTextNode("Two-way"))
      actions.append(toggle)
      actions.append(button("Sync now", () => run({ op: "sync", accountId: account.id })))
      if (link.twoWay) actions.append(button("Pull", () => run({ op: "pull", accountId: account.id })))
      actions.append(button("Unlink", () => run({ op: "unlink", accountId: account.id })))
    }
    item.append(title, meta, actions)
    list.append(item)
  }
  if (paired && !(state.accounts || []).length) {
    const empty = document.createElement("li")
    empty.textContent = "No accounts on this PC yet. Add one in TCGAIO, then refresh."
    list.append(empty)
  }
}

function button(label, onClick) {
  const node = document.createElement("button")
  node.type = "button"
  node.textContent = label
  node.addEventListener("click", onClick)
  return node
}

async function run(message) {
  showError("")
  const state = await ask(message)
  render(state)
}

document.querySelector("#pair-btn").addEventListener("click", () => run({ op: "pair", code: code.value }))
document.querySelector("#refresh").addEventListener("click", () => run({ op: "refresh" }))
document.querySelector("#disconnect").addEventListener("click", () => run({ op: "disconnect" }))

void ask({ op: "status" }).then(render).catch((err) => showError(err instanceof Error ? err.message : "Session Sync failed."))

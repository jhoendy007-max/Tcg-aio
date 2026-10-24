/**
 * The slim bar above a store sign-in window (0.2.44). It lives in its own trusted view,
 * never inside the store page. It copies the account email or password to the clipboard
 * through the main process. It does not type into or read the page.
 */
export const BAR_HEIGHT = 46
export const CLIPBOARD_CLEAR_MS = 30_000

export type BarField = "user" | "pass"

export const BAR_CHANNELS = {
  copy: "signin-bar:copy",
  reveal: "signin-bar:reveal"
} as const

export interface BarWords {
  account: string
  email: string
  password: string
  copy: string
  copied: string
  show: string
  hide: string
  none: string
  hint: string
}

export function barWords(lang: "en" | "es"): BarWords {
  return lang === "es"
    ? {
        account: "Cuenta",
        email: "Correo",
        password: "Contraseña",
        copy: "Copiar",
        copied: "Copiado · se borra en 30 s",
        show: "Mostrar",
        hide: "Ocultar",
        none: "Sin contraseña guardada",
        hint: "Solo copiar. Tú pegas."
      }
    : {
        account: "Account",
        email: "Email",
        password: "Password",
        copy: "Copy",
        copied: "Copied · clears in 30 s",
        show: "Show",
        hide: "Hide",
        none: "No password saved",
        hint: "Copy only. You paste it."
      }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] as string)
}

/**
 * HTML for the bar. It carries the label and email only. The password is never put in this
 * document: the bar shows dots, and asks the main process to reveal it when the person taps Show.
 */
export function barHtml(input: { label: string; username: string; hasPassword: boolean; lang: "en" | "es"; nonce: string }): string {
  const w = barWords(input.lang)
  const dots = "•".repeat(12)
  const pass = input.hasPassword
    ? `<span class="k">${escapeHtml(w.password)}</span><span id="pw" class="v mono" data-hidden="1">${dots}</span>
       <button id="show" type="button">${escapeHtml(w.show)}</button>
       <button id="cpass" type="button">${escapeHtml(w.copy)}</button>`
    : `<span class="k">${escapeHtml(w.password)}</span><span class="v dim">${escapeHtml(w.none)}</span>`
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${input.nonce}'">
<style>
html,body{margin:0;height:${BAR_HEIGHT}px;overflow:hidden;background:#12151c;color:#e8eaf0;font:13px system-ui,Segoe UI,sans-serif}
body{display:flex;align-items:center;gap:10px;padding:0 12px;box-sizing:border-box;border-bottom:1px solid #2a2f3a;user-select:none}
.k{color:#8b93a7}.v{max-width:300px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.mono{font-family:ui-monospace,Consolas,monospace;letter-spacing:1px}.dim{color:#6b7280}
.sep{width:1px;height:20px;background:#2a2f3a;margin:0 4px}.sp{flex:1}
button{background:#1f2430;color:#e8eaf0;border:1px solid #343b4a;border-radius:6px;padding:4px 10px;font:inherit;cursor:pointer}
button:hover{background:#283043}#st{color:#7ee0a0;min-width:150px;text-align:right}.h{color:#6b7280}
</style></head><body>
<span class="k">${escapeHtml(w.account)}</span><b class="v">${escapeHtml(input.label)}</b>
<span class="sep"></span>
<span class="k">${escapeHtml(w.email)}</span><span class="v">${escapeHtml(input.username)}</span>
<button id="cuser" type="button">${escapeHtml(w.copy)}</button>
<span class="sep"></span>
${pass}
<span class="sp"></span><span class="h">${escapeHtml(w.hint)}</span><span id="st"></span>
<script nonce="${input.nonce}">
const W=${JSON.stringify({ copied: w.copied, show: w.show, hide: w.hide })};
const st=document.getElementById('st');let t=null;
function say(){st.textContent=W.copied;clearTimeout(t);t=setTimeout(()=>{st.textContent=''},4000)}
document.getElementById('cuser').onclick=async()=>{if(await window.zzzBar.copy('user'))say()};
const cp=document.getElementById('cpass');if(cp)cp.onclick=async()=>{if(await window.zzzBar.copy('pass'))say()};
const sh=document.getElementById('show'),pw=document.getElementById('pw');
if(sh)sh.onclick=async()=>{const hidden=pw.dataset.hidden==='1';if(hidden){pw.textContent=await window.zzzBar.reveal(true);pw.dataset.hidden='0';sh.textContent=W.hide}else{pw.textContent='\\u2022'.repeat(12);pw.dataset.hidden='1';sh.textContent=W.show;await window.zzzBar.reveal(false)}};
</script></body></html>`
}

export interface ClipboardLike {
  writeText(text: string): void
  readText(): string
  clear(): void
}

export interface ClipboardTimers {
  set(fn: () => void, ms: number): unknown
  clear(handle: unknown): void
}

/**
 * Copy a value, then clear the clipboard after `ms` only if it still holds that same value.
 * Something the person copied in the meantime is left alone. Returns a cancel function.
 */
export function copyWithAutoClear(
  clipboard: ClipboardLike,
  value: string,
  ms = CLIPBOARD_CLEAR_MS,
  timers: ClipboardTimers = { set: (fn, delay) => setTimeout(fn, delay), clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>) }
): () => void {
  clipboard.writeText(value)
  const handle = timers.set(() => {
    try {
      if (clipboard.readText() === value) clipboard.clear()
    } catch {
      /* the clipboard is unavailable, nothing to clear */
    }
  }, ms)
  return () => timers.clear(handle)
}

import type { Database } from "./database"
import { fetchMailbox, type LineSocket } from "./imap"
import { messagesForStore, senderMatchesStore, verificationCode } from "../shared/mail"
import type { StoreId } from "../shared/types"

type Opener = (input: { host: string; port: number; secure: boolean }) => Promise<LineSocket>

/** Read a verification code from the user's own mailbox. The digits are not logged. */
export async function readStoreCode(db: Database, open: Opener, store: StoreId, now = Date.now()): Promise<string | null> {
  const since = new Date(now - 20 * 60 * 1000)
  for (const login of db.mailboxLogins("codes")) {
    try {
      const socket = await open({ host: login.host, port: login.port, secure: login.secure })
      const messages = await fetchMailbox(socket, { user: login.user, password: login.password, mailbox: login.mailbox, since })
      db.noteMailbox(login.id, { ok: true, error: "" })
      const matched = messages.filter((message) => senderMatchesStore(message.from, store))
      for (const message of matched.reverse()) {
        const code = verificationCode(`${message.subject}\n${message.text}`)
        if (code) return code
      }
    } catch (err) {
      db.noteMailbox(login.id, { ok: false, error: err instanceof Error ? err.message : "Mail could not be read." })
    }
  }
  return null
}

export async function readOrderMail(db: Database, open: Opener, store: StoreId, now = Date.now()): Promise<string> {
  const since = new Date(now - 3 * 24 * 60 * 60 * 1000)
  const parts: string[] = []
  for (const login of db.mailboxLogins("orders")) {
    try {
      const socket = await open({ host: login.host, port: login.port, secure: login.secure })
      const messages = await fetchMailbox(socket, { user: login.user, password: login.password, mailbox: login.mailbox, since })
      db.noteMailbox(login.id, { ok: true, error: "" })
      const text = messagesForStore(messages, store)
      if (text) parts.push(text)
    } catch (err) {
      db.noteMailbox(login.id, { ok: false, error: err instanceof Error ? err.message : "Mail could not be read." })
    }
  }
  return parts.join("\n")
}

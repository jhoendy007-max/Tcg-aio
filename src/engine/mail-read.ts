import type { Database, MailboxLogin } from "./database"
import { accessTokenFor } from "./mail-oauth"
import { fetchMailbox, type LineSocket, type MailAuth } from "./imap"
import { explainMailFailure, messagesForStore, senderMatchesStore, verificationCode } from "../shared/mail"
import type { StoreId } from "../shared/types"

type Opener = (input: { host: string; port: number; secure: boolean }) => Promise<LineSocket>

export async function imapCredential(db: Database, login: MailboxLogin): Promise<MailAuth> {
  if (login.auth !== "xoauth2") return { user: login.user, password: login.password, auth: "password" }
  if (login.provider !== "gmail" && login.provider !== "outlook") throw new Error("Sign-in is only available for Google and Microsoft.")
  const access = await accessTokenFor(db, login.provider, login.password)
  return { user: login.user, password: access, auth: "xoauth2" }
}

async function readMessages(db: Database, open: Opener, login: MailboxLogin, since: Date) {
  const cred = await imapCredential(db, login)
  const socket = await open({ host: login.host, port: login.port, secure: login.secure })
  return fetchMailbox(socket, { ...cred, mailbox: login.mailbox, since })
}

function noteFailure(db: Database, login: MailboxLogin, err: unknown): void {
  const raw = err instanceof Error ? err.message : "Mail could not be read."
  db.noteMailbox(login.id, { ok: false, error: explainMailFailure(raw, login.provider, db.getSettings().language) })
}

/** Read a verification code from the user's own mailbox. The digits are not logged. */
export async function readStoreCode(db: Database, open: Opener, store: StoreId, now = Date.now()): Promise<string | null> {
  const since = new Date(now - 20 * 60 * 1000)
  for (const login of db.mailboxLogins("codes")) {
    try {
      const messages = await readMessages(db, open, login, since)
      db.noteMailbox(login.id, { ok: true, error: "" })
      const matched = messages.filter((message) => senderMatchesStore(message.from, store))
      for (const message of matched.reverse()) {
        const code = verificationCode(`${message.subject}\n${message.text}`)
        if (code) return code
      }
    } catch (err) {
      noteFailure(db, login, err)
    }
  }
  return null
}

export async function readOrderMail(db: Database, open: Opener, store: StoreId, now = Date.now()): Promise<string> {
  const since = new Date(now - 3 * 24 * 60 * 60 * 1000)
  const parts: string[] = []
  for (const login of db.mailboxLogins("orders")) {
    try {
      const messages = await readMessages(db, open, login, since)
      db.noteMailbox(login.id, { ok: true, error: "" })
      const text = messagesForStore(messages, store)
      if (text) parts.push(text)
    } catch (err) {
      noteFailure(db, login, err)
    }
  }
  return parts.join("\n")
}

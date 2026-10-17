export interface ImapLogin {
  user: string
  password: string
  mailbox: string
  since: Date
}

import { connect as connectNet, type Socket } from "node:net"
import { connect as connectTls } from "node:tls"

const WRITERS = new Set(["APPEND", "STORE", "EXPUNGE", "COPY", "MOVE", "CREATE", "DELETE", "RENAME", "SUBSCRIBE", "UNSUBSCRIBE"])

export function openImap(host: string, port: number): Promise<LineSocket> {
  return openMailbox({ host, port, secure: true })
}

export function openMailbox(input: { host: string; port: number; secure: boolean }): Promise<LineSocket> {
  if (input.secure === false) return openStartTls(input.host, input.port)
  return openImplicit(input.host, input.port)
}

export interface LineSocket {
  send(line: string): Promise<void>
  read(): Promise<string>
}

export interface MailPiece {
  uid: string
  from: string
  subject: string
  text: string
}

/** Refuse any command that would change the mailbox. The password is never written by these checks. */
export function assertReadOnly(line: string): void {
  const parts = line.trim().split(/\s+/)
  const verb = (parts[1] ?? parts[0] ?? "").toUpperCase()
  if (WRITERS.has(verb)) throw new Error("TCGAIO only reads mail. It does not change the mailbox.")
}

/** Read the greeting and require STARTTLS before any login. A refusal does not send the password. */
export async function beginStartTls(socket: LineSocket): Promise<void> {
  const greet = await socket.read()
  if (!greet.includes("OK")) throw new Error("The mail server did not greet.")
  assertReadOnly("A0 STARTTLS")
  await socket.send("A0 STARTTLS")
  const reply = await readTag(socket, "A0")
  if (!/\bOK\b/i.test(reply)) throw new Error("The server does not offer STARTTLS. The password was not sent.")
}

/** LOGIN, LIST, LOGOUT. Returns folder names. Does not select or change mail. */
export async function testMailbox(socket: LineSocket, login: { user: string; password: string }): Promise<string[]> {
  const send = guarded(socket)
  const greet = await socket.read()
  if (!greet.includes("OK")) throw new Error("The mail server did not greet.")
  await send(`A1 LOGIN ${quote(login.user)} ${quote(login.password)}`)
  const authed = await readTag(socket, "A1")
  if (!/\bOK\b/i.test(authed)) throw new Error("The mail server refused the login. Check the username and app password.")
  await send(`A2 LIST "" "*"`)
  const listed = await readTag(socket, "A2")
  await send("A3 LOGOUT")
  const folders = parseList(listed)
  return folders.length ? folders : ["INBOX"]
}

/** Read recent message headers and a short text peek. The password is not logged. */
export async function fetchMailbox(socket: LineSocket, login: ImapLogin): Promise<MailPiece[]> {
  const send = guarded(socket)
  const greet = await socket.read()
  if (!greet.includes("OK")) throw new Error("The mail server did not greet.")
  await send(`A1 LOGIN ${quote(login.user)} ${quote(login.password)}`)
  const authed = await readTag(socket, "A1")
  if (!/\bOK\b/i.test(authed)) throw new Error("The mail server refused the login.")
  await send(`A2 SELECT ${quote(login.mailbox || "INBOX")}`)
  const selected = await readTag(socket, "A2")
  if (!/\bOK\b/i.test(selected)) throw new Error("The mailbox could not be opened.")
  const since = formatImapDate(login.since)
  await send(`A3 UID SEARCH SINCE ${since}`)
  const searched = await readTag(socket, "A3")
  const ids = searchIds(searched)
  if (!ids.length) {
    await send("A5 LOGOUT")
    return []
  }
  await send(`A4 UID FETCH ${ids.join(",")} (BODY.PEEK[HEADER.FIELDS (FROM SUBJECT)] BODY.PEEK[TEXT]<0.8000>)`)
  const fetched = await readTag(socket, "A4")
  await send("A5 LOGOUT")
  return parseFetchedMail(fetched)
}

/** Read recent message text from a mailbox the user connected. The password is not logged. */
export async function fetchRecentMail(socket: LineSocket, login: ImapLogin): Promise<string> {
  const greet = await socket.read()
  if (!greet.includes("OK")) throw new Error("The mail server did not greet.")
  await socket.send(`A1 LOGIN ${quote(login.user)} ${quote(login.password)}`)
  const authed = await readTag(socket, "A1")
  if (!/\bOK\b/i.test(authed)) throw new Error("The mail server refused the login.")
  await socket.send(`A2 SELECT ${quote(login.mailbox || "INBOX")}`)
  const selected = await readTag(socket, "A2")
  if (!/\bOK\b/i.test(selected)) throw new Error("The mailbox could not be opened.")
  const since = formatImapDate(login.since)
  await socket.send(`A3 UID SEARCH SINCE ${since}`)
  const searched = await readTag(socket, "A3")
  const ids = searchIds(searched)
  if (!ids.length) {
    await socket.send("A5 LOGOUT")
    return ""
  }
  await socket.send(`A4 UID FETCH ${ids.join(",")} (BODY.PEEK[TEXT]<0.12000>)`)
  const fetched = await readTag(socket, "A4")
  await socket.send("A5 LOGOUT")
  return fetched
}

export function quote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

export function formatImapDate(date: Date): string {
  const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
  return `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()}`
}

export function parseList(text: string): string[] {
  const names: string[] = []
  for (const line of text.split(/\n/)) {
    if (!line.toUpperCase().startsWith("* LIST")) continue
    const quoted = line.match(/"((?:\\.|[^"\\])*)"\s*$/)
    if (quoted) {
      names.push(quoted[1].replace(/\\"/g, '"').replace(/\\\\/g, "\\"))
      continue
    }
    const bare = line.trim().match(/\s(\S+)$/)
    if (bare && bare[1] !== ")" && !bare[1].startsWith("(") && bare[1] !== '"') names.push(bare[1])
  }
  return [...new Set(names.map((name) => name.trim()).filter(Boolean))].slice(0, 80)
}

export function parseFetchedMail(raw: string): MailPiece[] {
  const parts = raw.split(/\n(?=\* \d+ FETCH\b)/i)
  const pieces: MailPiece[] = []
  for (const part of parts) {
    if (!/\* \d+ FETCH\b/i.test(part)) continue
    const uid = part.match(/\bUID (\d+)/i)?.[1] ?? ""
    const from = headerField(part, "from")
    const subject = headerField(part, "subject")
    const text = part
      .split(/\n/)
      .filter((line) => !/^(?:\*\s|\s*\)|From:|Subject:|Date:|To:|MIME-|Content-)/i.test(line.trim()) && !/^A\d+ /.test(line.trim()))
      .join("\n")
      .trim()
    if (!uid && !from && !subject) continue
    pieces.push({ uid, from, subject, text })
  }
  return pieces
}

function headerField(part: string, name: string): string {
  const match = part.match(new RegExp(`^${name}:\\s*(.+)$`, "im"))
  return match?.[1]?.trim() ?? ""
}

function searchIds(searched: string): string[] {
  return searched
    .split(/\r?\n/)
    .filter((line) => line.toUpperCase().startsWith("* SEARCH"))
    .flatMap((line) => line.split(/\s+/).slice(2))
    .filter((id) => /^\d+$/.test(id))
    .slice(-8)
}

function guarded(socket: LineSocket): (line: string) => Promise<void> {
  return async (line: string) => {
    assertReadOnly(line)
    await socket.send(line)
  }
}

async function readTag(socket: LineSocket, tag: string): Promise<string> {
  const chunks: string[] = []
  for (let i = 0; i < 40; i += 1) {
    const line = await socket.read()
    chunks.push(line)
    if (line.startsWith(`${tag} `)) return chunks.join("\n")
  }
  throw new Error("The mail server stopped responding.")
}

function openImplicit(host: string, port: number): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host, port, servername: host, rejectUnauthorized: true })
    socket.once("error", reject)
    socket.once("secureConnect", () => {
      socket.removeListener("error", reject)
      resolve(createReader(socket))
    })
  })
}

function openStartTls(host: string, port: number): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    const plain = connectNet({ host, port })
    const fail = (err: unknown) => {
      plain.destroy()
      reject(err instanceof Error ? err : new Error("The mail server could not be reached."))
    }
    plain.once("error", fail)
    plain.once("connect", () => {
      const reader = createReader(plain)
      void beginStartTls(reader)
        .then(() => {
          reader.detach()
          const secure = connectTls({ socket: plain, servername: host, rejectUnauthorized: true })
          secure.once("error", fail)
          secure.once("secureConnect", () => {
            plain.removeListener("error", fail)
            secure.removeListener("error", fail)
            resolve(createReader(secure))
          })
        })
        .catch(fail)
    })
  })
}

function createReader(socket: Socket): LineSocket & { detach(): void } {
  const lines: string[] = []
  const waiters: Array<(line: string) => void> = []
  let buffer = ""
  const onData = (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8")
    let index = buffer.indexOf("\n")
    while (index >= 0) {
      const line = buffer.slice(0, index).replace(/\r$/, "")
      buffer = buffer.slice(index + 1)
      const waiter = waiters.shift()
      if (waiter) waiter(line)
      else lines.push(line)
      index = buffer.indexOf("\n")
    }
  }
  socket.on("data", onData)
  return {
    send: (line) => new Promise((res, rej) => {
      socket.write(`${line}\r\n`, (err) => (err ? rej(err) : res()))
    }),
    read: () => {
      const queued = lines.shift()
      if (queued !== undefined) return Promise.resolve(queued)
      return new Promise((res) => waiters.push(res))
    },
    detach: () => {
      socket.removeListener("data", onData)
    }
  }
}

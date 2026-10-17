export interface ImapLogin {
  user: string
  password: string
  mailbox: string
  since: Date
}

import { connect as connectTls } from "node:tls"

export function openImap(host: string, port: number): Promise<LineSocket> {
  return new Promise((resolve, reject) => {
    const socket = connectTls({ host, port, servername: host, rejectUnauthorized: true })
    const lines: string[] = []
    const waiters: Array<(line: string) => void> = []
    let buffer = ""
    socket.setEncoding("utf8")
    socket.on("data", (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf("\n")
      while (index >= 0) {
        const line = buffer.slice(0, index).replace(/\r$/, "")
        buffer = buffer.slice(index + 1)
        const waiter = waiters.shift()
        if (waiter) waiter(line)
        else lines.push(line)
        index = buffer.indexOf("\n")
      }
    })
    socket.once("error", reject)
    socket.once("secureConnect", () => {
      resolve({
        send: (line) => new Promise((res, rej) => {
          socket.write(`${line}\r\n`, (err) => (err ? rej(err) : res()))
        }),
        read: () => {
          const queued = lines.shift()
          if (queued !== undefined) return Promise.resolve(queued)
          return new Promise((res) => waiters.push(res))
        }
      })
    })
  })
}

export interface LineSocket {
  send(line: string): Promise<void>
  read(): Promise<string>
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
  const ids = searched
    .split(/\r?\n/)
    .filter((line) => line.toUpperCase().startsWith("* SEARCH"))
    .flatMap((line) => line.split(/\s+/).slice(2))
    .filter((id) => /^\d+$/.test(id))
    .slice(-5)
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

async function readTag(socket: LineSocket, tag: string): Promise<string> {
  const chunks: string[] = []
  for (let i = 0; i < 40; i += 1) {
    const line = await socket.read()
    chunks.push(line)
    if (line.startsWith(`${tag} `)) return chunks.join("\n")
  }
  throw new Error("The mail server stopped responding.")
}

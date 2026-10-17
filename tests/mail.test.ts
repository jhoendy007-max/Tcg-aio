import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { beginStartTls, fetchMailbox, parseFetchedMail, parseList, testMailbox, type LineSocket } from "../src/engine/imap"
import { otpFillScript } from "../src/engine/otp"
import { readStoreCode } from "../src/engine/mail-read"
import {
  MAIL_PRESETS,
  mailAlertDetail,
  messagesForStore,
  senderMatchesStore,
  storeForSender,
  verificationCode
} from "../src/shared/mail"

function scripted(lines: string[]): { socket: LineSocket; sent: string[] } {
  const pending = [...lines]
  const sent: string[] = []
  return {
    sent,
    socket: {
      async send(line: string) {
        sent.push(line)
      },
      async read() {
        const line = pending.shift()
        if (line === undefined) throw new Error("ended")
        return line
      }
    }
  }
}

describe("mail presets and parsing", () => {
  it("uses the provider hosts and app-password guidance", () => {
    expect(MAIL_PRESETS.gmail).toMatchObject({ host: "imap.gmail.com", port: 993, secure: true })
    expect(MAIL_PRESETS.outlook.host).toBe("outlook.office365.com")
    expect(MAIL_PRESETS.icloud.host).toBe("imap.mail.me.com")
    expect(MAIL_PRESETS.yahoo.host).toBe("imap.mail.yahoo.com")
    expect(MAIL_PRESETS.gmail.guidance.toLowerCase()).toContain("app password")
    expect(MAIL_PRESETS.icloud.guidance).toContain("full iCloud email")
  })

  it("keeps a verification code and drops a card number and a tracking number", () => {
    expect(verificationCode("Your verification code is 123456.")).toBe("123456")
    expect(verificationCode("Use 654321 as your one-time passcode. Also code 12345678.")).toBe("654321")
    expect(verificationCode("Tracking 1Z999AA10123456784 is your code reference.")).toBeNull()
    expect(verificationCode("Card 4242 4242 4242 4242 verification 4242424242424242")).toBeNull()
    expect(verificationCode("Order number 99887766")).toBeNull()
  })

  it("matches store sender domains and ignores a lookalike host", () => {
    expect(senderMatchesStore("Target <orders@em.target.com>", "target")).toBe(true)
    expect(senderMatchesStore("news@email.bestbuy.com", "bestbuy")).toBe(true)
    expect(senderMatchesStore("evil@target.com.attacker.test", "target")).toBe(false)
    expect(storeForSender("Amazon <auto-confirm@amazon.com>")).toBe("amazon")
    expect(storeForSender("person@example.com")).toBeNull()
    const text = messagesForStore([
      { from: "orders@walmart.com", subject: "Shipped", text: "Order 42 shipped" },
      { from: "orders@target.com", subject: "Target", text: "Order 42 shipped" }
    ], "target")
    expect(text).toContain("Target")
    expect(text).not.toContain("walmart")
  })

  it("masks digits in a restock alert subject", () => {
    expect(mailAlertDetail("Back in stock 123456")).toBe("Store mail: Back in stock ••••")
    expect(mailAlertDetail("")).toBe("Store mail: restock or newsletter")
  })
})

describe("IMAP read commands", () => {
  it("tests a connection with login, list, and logout", async () => {
    const { socket, sent } = scripted([
      "* OK ready",
      "A1 OK logged in",
      '* LIST (\\HasNoChildren) "/" "INBOX"',
      '* LIST (\\HasNoChildren) "/" "Orders"',
      "A2 OK list"
    ])
    const folders = await testMailbox(socket, { user: "ada@example.com", password: "app-secret" })
    expect(sent.map((line) => line.split(/\s+/)[1])).toEqual(["LOGIN", "LIST", "LOGOUT"])
    expect(sent.join("\n")).not.toMatch(/\b(APPEND|STORE|EXPUNGE|COPY|MOVE)\b/)
    expect(folders).toEqual(["INBOX", "Orders"])
    expect(JSON.stringify(folders)).not.toContain("app-secret")
  })

  it("refuses to send a password when STARTTLS is missing", async () => {
    const { socket, sent } = scripted(["* OK ready", "A0 NO STARTTLS unavailable"])
    await expect(beginStartTls(socket)).rejects.toThrow(/password was not sent/i)
    expect(sent).toEqual(["A0 STARTTLS"])
  })

  it("reads From and Subject and leaves the password out of the messages", async () => {
    const raw = [
      "* 1 FETCH (UID 10 BODY[HEADER.FIELDS (FROM SUBJECT)] {40}",
      "From: orders@em.target.com",
      "Subject: Your code is 123456",
      "",
      "Your verification code is 123456",
      "A4 OK fetch"
    ].join("\n")
    expect(parseFetchedMail(raw)[0]).toMatchObject({
      uid: "10",
      from: "orders@em.target.com",
      subject: "Your code is 123456"
    })
    expect(parseList('* LIST (\\HasNoChildren) "/" INBOX')).toEqual(["INBOX"])
    const { socket } = scripted([
      "* OK ready",
      "A1 OK logged in",
      "A2 OK selected",
      "* SEARCH 10",
      "A3 OK search",
      ...raw.split("\n")
    ])
    const messages = await fetchMailbox(socket, {
      user: "ada@example.com",
      password: "app-secret",
      mailbox: "INBOX",
      since: new Date("2026-10-16T00:00:00Z")
    })
    expect(messages[0]?.from).toBe("orders@em.target.com")
    expect(JSON.stringify(messages)).not.toContain("app-secret")
  })

  it("fills a one-time-code field and skips a captcha control", () => {
    const script = otpFillScript("123456")
    expect(script).toContain('input[autocomplete="one-time-code"]')
    expect(script).toContain("123456")
    expect(script).toContain("captcha")
    expect(script).not.toContain("2captcha")
    expect(otpFillScript('1"2')).toContain('"1\\"2"')
  })
})

describe("mailbox storage", () => {
  it("migrates one encrypted mailbox and can store several", () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-mail-"))
    const file = join(dir, "tcgaio.json")
    const cipher = createAesCipher(dir)
    writeFileSync(file, JSON.stringify({
      version: 1,
      pcId: "00000000-0000-4000-8000-000000000001",
      profiles: [],
      accounts: [],
      proxyGroups: [],
      tasks: [],
      devices: [],
      imap: {
        enabled: true,
        host: "imap.gmail.com",
        port: 993,
        user: "ada@gmail.com",
        mailbox: "INBOX",
        passwordSecret: cipher.encrypt("app-secret")
      }
    }))
    const db = new Database(file, cipher)
    db.load()
    const migrated = db.listMailboxes()
    expect(migrated).toHaveLength(1)
    expect(migrated[0]).toMatchObject({ provider: "gmail", host: "imap.gmail.com", orders: true, codes: true, hasPassword: true })
    expect(readFileSync(file, "utf8")).not.toContain("app-secret")
    expect(db.mailboxLogins("codes")[0]?.password).toBe("app-secret")

    const second = db.saveMailbox({
      name: "Yahoo",
      enabled: true,
      provider: "yahoo",
      host: "imap.mail.yahoo.com",
      port: 993,
      secure: true,
      user: "ada@yahoo.com",
      mailbox: "INBOX",
      password: "yahoo-secret",
      passwordAction: "replace",
      orders: false,
      alerts: true,
      codes: false
    })
    expect(db.listMailboxes()).toHaveLength(2)
    expect(db.mailboxLogins("alerts").map((row) => row.user)).toEqual(["ada@yahoo.com"])
    expect(db.mailboxLogins("orders").map((row) => row.user)).toEqual(["ada@gmail.com"])
    db.noteMailbox(second.id, { ok: false, error: "The mail server refused the login." })
    expect(db.mailboxStatus()).toMatchObject({ accounts: 2, enabled: 2, ready: 1, lastError: "The mail server refused the login." })
    expect(db.claimMailAlert(second.id, "10")).toBe(true)
    expect(db.claimMailAlert(second.id, "10")).toBe(false)
    expect(db.imapView().user).toBe("ada@gmail.com")
  })

  it("returns a code only from the matching store sender", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-mail-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    db.saveMailbox({
      name: "Gmail",
      enabled: true,
      provider: "gmail",
      host: "imap.gmail.com",
      port: 993,
      secure: true,
      user: "ada@gmail.com",
      mailbox: "INBOX",
      password: "app-secret",
      passwordAction: "replace",
      orders: true,
      alerts: false,
      codes: true
    })
    const raw = [
      "* 1 FETCH (UID 4 BODY[HEADER.FIELDS (FROM SUBJECT)] {20}",
      "From: other@example.com",
      "Subject: code 111111",
      "Your verification code is 111111",
      "* 2 FETCH (UID 5 BODY[HEADER.FIELDS (FROM SUBJECT)] {20}",
      "From: orders@amazon.com",
      "Subject: Amazon code",
      "Your verification code is 222333",
      "A4 OK fetch"
    ]
    const code = await readStoreCode(db, async () => scripted([
      "* OK ready",
      "A1 OK logged in",
      "A2 OK selected",
      "* SEARCH 4 5",
      "A3 OK search",
      ...raw
    ]).socket, "amazon")
    expect(code).toBe("222333")
  })
})

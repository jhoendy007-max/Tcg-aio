import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { createAesCipher } from "../src/engine/cipher"
import { Database } from "../src/engine/database"
import { beginStartTls, fetchMailbox, parseFetchedMail, parseList, testMailbox, xoauth2Initial, type LineSocket } from "../src/engine/imap"
import { authorizeUrl, completeMailSignIn, listenForOAuthCode, tokenForm } from "../src/engine/mail-oauth"
import { otpFillScript } from "../src/engine/otp"
import { readStoreCode } from "../src/engine/mail-read"
import { createPhoneHost } from "../src/phone/backend"
import { asClientMessage } from "../src/phone/protocol"
import {
  MAIL_PRESETS,
  detectMailbox,
  explainMailFailure,
  isMailHelpUrl,
  isOAuthUrl,
  mailAlertDetail,
  messagesForStore,
  senderMatchesStore,
  storeForSender,
  verificationCode
} from "../src/shared/mail"
import { mailGuide, mailText } from "../src/shared/mail-text"

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

describe("easy mailbox setup", () => {
  it("detects the provider, host, port, and SSL from the email address", () => {
    expect(detectMailbox("Ada@Gmail.com")).toMatchObject({ provider: "gmail", host: "imap.gmail.com", port: 993, secure: true, guessed: false })
    expect(detectMailbox("ada@hotmail.com")?.provider).toBe("outlook")
    expect(detectMailbox("ada@live.com")?.host).toBe("outlook.office365.com")
    expect(detectMailbox("ada@icloud.com")).toMatchObject({ provider: "icloud", host: "imap.mail.me.com" })
    expect(detectMailbox("ada@me.com")?.provider).toBe("icloud")
    expect(detectMailbox("ada@yahoo.com")).toMatchObject({ provider: "yahoo", host: "imap.mail.yahoo.com", secure: true })
    expect(detectMailbox("ada@shop.example")).toMatchObject({ provider: "custom", host: "imap.shop.example", port: 993, secure: true, guessed: true })
    expect(detectMailbox("not-an-email")).toBeNull()
    expect(detectMailbox("a@b")).toBeNull()
  })

  it("explains a failed test in English and Spanish", () => {
    expect(explainMailFailure("The server does not offer STARTTLS. The password was not sent.", "icloud", "en")).toContain("password was not sent")
    expect(explainMailFailure("STARTTLS missing", "icloud", "es")).toContain("no se envió")
    expect(explainMailFailure("invalid_grant", "gmail", "es")).toContain("caducó")
    expect(explainMailFailure("client id is not set up", "outlook", "en")).toContain("Microsoft")
    expect(explainMailFailure("authenticationfailed", "yahoo", "es")).toContain("contraseña de aplicación")
    expect(explainMailFailure("ETIMEDOUT", "custom", "en")).toContain("did not answer")
    expect(explainMailFailure("Bearer ya29.secret-token refused", "custom", "en")).not.toContain("ya29")
  })

  it("builds a public PKCE sign-in URL and a token form with no client secret", () => {
    const google = authorizeUrl({
      provider: "gmail",
      clientId: "desktop.apps.googleusercontent.com",
      redirectUri: "http://127.0.0.1:9/callback",
      challenge: "challenge",
      state: "state",
      loginHint: "ada@gmail.com"
    })
    expect(isOAuthUrl(google)).toBe(true)
    expect(google).toContain("code_challenge_method=S256")
    expect(google).toContain("scope=https%3A%2F%2Fmail.google.com%2F")
    expect(google).not.toContain("client_secret")
    const microsoft = tokenForm({
      provider: "outlook",
      clientId: "00000000-0000-4000-8000-000000000001",
      code: "code",
      verifier: "verifier",
      redirectUri: "http://127.0.0.1:9/callback"
    })
    expect(microsoft).not.toContain("client_secret")
    expect(microsoft).toContain("code_verifier=verifier")
    expect(isOAuthUrl("https://login.microsoftonline.com/common/oauth2/v2.0/authorize")).toBe(true)
    expect(isOAuthUrl("https://evil.example/authorize")).toBe(false)
  })

  it("authenticates with XOAUTH2 and answers a continuation with an empty line", async () => {
    const token = "access-token-value"
    expect(Buffer.from(xoauth2Initial("ada@gmail.com", token), "base64").toString("utf8")).toBe(`user=ada@gmail.com\u0001auth=Bearer ${token}\u0001\u0001`)
    const { socket, sent } = scripted([
      "* OK ready",
      "+",
      "A1 OK authed",
      '* LIST (\\HasNoChildren) "/" "INBOX"',
      "A2 OK list"
    ])
    const folders = await testMailbox(socket, { user: "ada@gmail.com", password: token, auth: "xoauth2" })
    expect(sent[0]).toMatch(/^A1 AUTHENTICATE XOAUTH2 /)
    expect(sent[1]).toBe("")
    expect(sent.map((line) => line.split(/\s+/)[1]).filter(Boolean)).toEqual(["AUTHENTICATE", "LIST", "LOGOUT"])
    expect(sent.join("\n")).not.toMatch(/\b(LOGIN|APPEND|STORE|EXPUNGE|COPY|MOVE)\b/)
    expect(folders).toEqual(["INBOX"])
  })

  it("links only the official app-password pages", () => {
    for (const provider of ["gmail", "outlook", "icloud", "yahoo", "custom"] as const) {
      for (const lang of ["en", "es"] as const) {
        const guide = mailGuide(provider, lang)
        expect(guide.steps.length).toBeGreaterThan(0)
        for (const link of guide.links) expect(isMailHelpUrl(link.href)).toBe(true)
      }
    }
    expect(mailGuide("icloud", "en").links[0]?.href).toBe("https://appleid.apple.com/account/manage")
    expect(mailGuide("yahoo", "es").links[0]?.href).toBe("https://login.yahoo.com/account/security")
    expect(isMailHelpUrl("http://appleid.apple.com/account/manage")).toBe(false)
    expect(isMailHelpUrl("https://evil.example/apppasswords")).toBe(false)
    expect(mailText("es", "signInGoogle")).toContain("Google")
    expect(mailText("en", "signInMicrosoft")).toContain("Microsoft")
  })

  it("stores the refresh token encrypted and keeps the sign-in off the password path", async () => {
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-oauth-"))
    const file = join(dir, "tcgaio.json")
    const db = new Database(file, createAesCipher(dir))
    db.load()
    await expect(completeMailSignIn(db, { provider: "gmail", user: "ada@gmail.com" }, { open() { return undefined } })).rejects.toThrow(/client ID/i)
    db.saveSettings({ ...db.getSettings(), language: "es", googleMailClientId: "desktop.apps.googleusercontent.com" })
    await expect(completeMailSignIn(db, { provider: "gmail", user: "" }, { open() { return undefined } })).rejects.toThrow(/correo/i)
    db.saveSettings({ ...db.getSettings(), language: "en" })
    let posts = 0
    const view = await completeMailSignIn(db, { provider: "gmail", user: "ada@gmail.com" }, {
      async open(url) {
        const parsed = new URL(url)
        expect(parsed.hostname).toBe("accounts.google.com")
        await fetch(`${parsed.searchParams.get("redirect_uri")}?code=the-code&state=${parsed.searchParams.get("state")}`)
      },
      async post(_url, body) {
        posts += 1
        expect(body).not.toContain("client_secret")
        expect(body).toContain("code=the-code")
        return { status: 200, body: JSON.stringify({ access_token: "access-1", refresh_token: "refresh-plain-token", expires_in: 3600 }) }
      }
    })
    expect(posts).toBe(1)
    expect(view).toMatchObject({ auth: "xoauth2", host: "imap.gmail.com", port: 993, user: "ada@gmail.com", hasPassword: true })
    expect(readFileSync(file, "utf8")).not.toContain("refresh-plain-token")
    expect(db.mailboxSecret(view.id)).toMatchObject({ auth: "xoauth2", password: "refresh-plain-token" })
    const replaced = db.saveMailbox({
      id: view.id,
      name: view.name,
      enabled: true,
      provider: "gmail",
      host: view.host,
      port: view.port,
      secure: true,
      user: view.user,
      mailbox: "INBOX",
      password: "app-secret",
      passwordAction: "replace",
      orders: true,
      alerts: false,
      codes: true
    })
    expect(replaced.auth).toBe("password")
    expect(db.mailboxSecret(view.id)?.password).toBe("app-secret")
    expect(readFileSync(file, "utf8")).not.toContain("app-secret")
  })

  it("accepts the loopback code and rejects a cancelled sign-in", async () => {
    const ok = await listenForOAuthCode("state-ok", 2_000)
    try {
      const pending = ok.done
      const response = await fetch(`${ok.redirectUri}?code=abc&state=state-ok`)
      expect(response.status).toBe(200)
      await expect(pending).resolves.toBe("abc")
    } finally {
      ok.close()
    }
    const denied = await listenForOAuthCode("state-no", 2_000)
    try {
      const pending = expect(denied.done).rejects.toThrow(/cancelled/i)
      await fetch(`${denied.redirectUri}?error=access_denied&state=state-no`)
      await pending
    } finally {
      denied.close()
    }
  })

  it("lets the phone add a mailbox and switch the mail language", () => {
    const draft = asClientMessage({
      type: "mail.save",
      req: "1",
      conn: "c",
      mailbox: { user: "ada@icloud.com", provider: "custom", host: "", port: 0, password: "icloud-app", orders: true, codes: true }
    })
    expect(draft.type).toBe("mail.save")
    if (draft.type !== "mail.save") return
    expect(draft.mailbox.user).toBe("ada@icloud.com")
    expect(() => asClientMessage({ type: "mail.save", req: "1", conn: "c", mailbox: { user: "nope" } })).toThrow(/email/i)
    const dir = mkdtempSync(join(tmpdir(), "tcgaio-phone-mail-"))
    const db = new Database(join(dir, "tcgaio.json"), createAesCipher(dir))
    db.load()
    const host = createPhoneHost(db, () => null)
    host.saveMailbox?.(draft.mailbox)
    expect(db.listMailboxes()[0]).toMatchObject({ provider: "icloud", host: "imap.mail.me.com", port: 993, secure: true })
    expect(readFileSync(join(dir, "tcgaio.json"), "utf8")).not.toContain("icloud-app")
    host.setLanguage?.("es")
    expect(db.getSettings().language).toBe("es")
    expect(host.snapshot().language).toBe("es")
    expect(host.snapshot().imap?.mailboxes?.[0]?.user).toBe("ada@icloud.com")
    expect(JSON.stringify(host.snapshot())).not.toContain("icloud-app")
  })
})

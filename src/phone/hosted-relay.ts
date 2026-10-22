export interface HostedRelay {
  url: string
  channel: string
  pcToken: string
  inviteToken: string
}

export function relaySocketUrl(httpBase: string): string {
  const url = new URL(httpBase)
  if (url.protocol === "https:") url.protocol = "wss:"
  else if (url.protocol === "http:") url.protocol = "ws:"
  else throw new Error("The license server URL is not http or https.")
  url.pathname = "/v1/phone/relay"
  url.search = ""
  url.hash = ""
  return url.toString()
}

export async function provisionHostedRelay(input: {
  licenseUrl: string
  sessionToken: string
  saved: { channel: string; token: string } | null
  fetchImpl?: typeof fetch
}): Promise<HostedRelay> {
  const base = input.licenseUrl.replace(/\/$/, "")
  const ask = input.fetchImpl ?? fetch
  const first = await postRelay(ask, base, input.sessionToken, "/v1/phone/relay", input.saved ? {} : { rotate: true })
  const created = input.saved && first.channel !== input.saved.channel
    ? await postRelay(ask, base, input.sessionToken, "/v1/phone/relay", { rotate: true })
    : first
  const channel = text(created.channel)
  const pcToken = text(created.pcToken) || (input.saved && input.saved.channel === channel ? input.saved.token : "")
  if (!channel || !pcToken) throw new Error("The license server did not open a phone relay.")
  const invite = await postRelay(ask, base, input.sessionToken, "/v1/phone/relay/invite", {})
  const inviteToken = text(invite.token)
  if (!inviteToken) throw new Error("The license server did not open a phone relay.")
  return { url: relaySocketUrl(base), channel, pcToken, inviteToken }
}

export async function mintRelayDevice(input: {
  licenseUrl: string
  sessionToken: string
  deviceId: string
  fetchImpl?: typeof fetch
}): Promise<string> {
  const base = input.licenseUrl.replace(/\/$/, "")
  const minted = await postRelay(input.fetchImpl ?? fetch, base, input.sessionToken, "/v1/phone/relay/device", { deviceId: input.deviceId })
  const token = text(minted.token)
  if (!token) throw new Error("The license server did not accept this phone.")
  return token
}

export async function revokeRelayDevice(input: {
  licenseUrl: string
  sessionToken: string
  deviceId: string
  fetchImpl?: typeof fetch
}): Promise<void> {
  const base = input.licenseUrl.replace(/\/$/, "")
  await postRelay(input.fetchImpl ?? fetch, base, input.sessionToken, "/v1/phone/relay/revoke", { deviceId: input.deviceId })
}

async function postRelay(ask: typeof fetch, base: string, sessionToken: string, path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await ask(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify(body)
  })
  const parsed = await response.json() as Record<string, unknown>
  if (!response.ok || parsed.ok !== true) {
    const error = typeof parsed.error === "string" ? parsed.error : "The phone relay could not be opened."
    throw new Error(error)
  }
  return parsed
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

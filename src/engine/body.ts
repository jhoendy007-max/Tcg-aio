import { createHash, timingSafeEqual } from "node:crypto"
import type { IncomingMessage } from "node:http"

export function readHttpBody(req: IncomingMessage, max: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on("data", (chunk: Buffer) => {
      size += chunk.length
      if (size > max) {
        reject(new Error("Body is too large."))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")))
    req.on("error", reject)
  })
}

/** Compare a bearer token or X-TCGAIO-Token header without leaking the stored token in errors. */
export function tokenAccepted(authorization: string | undefined, alternate: string | undefined, token: string): boolean {
  if (!token) return false
  const bearer = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? ""
  return safeEqual(bearer, token) || safeEqual((alternate ?? "").trim(), token)
}

function safeEqual(left: string, right: string): boolean {
  if (!left || !right) return false
  const a = createHash("sha256").update(left).digest()
  const b = createHash("sha256").update(right).digest()
  return timingSafeEqual(a, b)
}

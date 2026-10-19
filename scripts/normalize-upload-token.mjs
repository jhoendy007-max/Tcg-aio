function unwrapUploadToken(value) {
  let text = value.trim().replace(/^\uFEFF/, "")
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) text = text.slice(1, -1)
  text = text.replace(/^TCGAIO_ADMIN_UPLOAD_TOKEN=/i, "")
  text = text.replace(/^Bearer\s+/i, "")
  return text.trim()
}

let text = String(process.env.TCGAIO_ADMIN_UPLOAD_TOKEN ?? "")
for (let pass = 0; pass < 4; pass += 1) {
  const next = unwrapUploadToken(text)
  if (next === text) break
  text = next
}
process.stdout.write(text.replace(/\s+/g, ""))

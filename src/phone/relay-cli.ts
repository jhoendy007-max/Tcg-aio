import { RelayServer } from "./relay"

const port = Number(process.env.PHONE_RELAY_PORT || 47322)
const relay = new RelayServer(port, "0.0.0.0")
relay.start().then(() => {
  console.log(`TCGAIO phone relay listening on ${relay.port}`)
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err)
  process.exit(1)
})

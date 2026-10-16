import { networkInterfaces } from "node:os"

export function lanIPv4(): string {
  const nets = networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list ?? []) {
      const family = net.family as string | number
      if ((family === "IPv4" || family === 4) && !net.internal) return net.address
    }
  }
  return "127.0.0.1"
}

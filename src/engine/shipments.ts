import type { Database } from "./database"
import type { LineSocket } from "./imap"
import { readOrderMail } from "./mail-read"
import { shipmentFromMail } from "./orders"
import type { OrderRecord, StoreId } from "../shared/types"

type Opener = (input: { host: string; port: number; secure: boolean }) => Promise<LineSocket>

/** Read shipping mail the user connected and update each open order. This does not send mail. */
export async function refreshShipments(db: Database, open: Opener): Promise<{ orders: OrderRecord[]; updated: number; note: string }> {
  const openOrders = db.listOrders().filter((order) => order.status !== "cancelled" && order.status !== "delivered")
  const stores = [...new Set(openOrders.map((order) => order.store))]
  let updated = 0
  for (const store of stores) {
    const text = await readStoreMail(db, open, store)
    if (!text) continue
    for (const order of openOrders.filter((item) => item.store === store)) {
      const found = shipmentFromMail(text, order.orderId)
      if (!found) continue
      db.noteOrder(order.id, found.status, found.tracking, found.detail, found.carrier)
      updated += 1
    }
  }
  const note = updated ? "" : openOrders.length ? "No new shipping mail." : ""
  return { orders: db.listOrders(), updated, note }
}

async function readStoreMail(db: Database, open: Opener, store: StoreId): Promise<string> {
  try {
    return await readOrderMail(db, open, store)
  } catch {
    return ""
  }
}

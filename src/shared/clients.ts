import type { Address, CardSecret, Notice, StoreId } from "./types"

export const ME_CLIENT_ID = "me"

export type ClientStatus = "active" | "paused"
export type FeeBasis = "success" | "item"

export interface Client {
  id: string
  name: string
  contact: string
  notes: string
  /** Dollars charged once per successful order, or once per unit. */
  feeBasis: FeeBasis
  fee: number
  status: ClientStatus
  /** Optional Discord webhook. Success posts never include a card number. */
  webhook: string
  createdAt: number
}

export interface ClientInput {
  id?: string
  name: string
  contact?: string
  notes?: string
  feeBasis?: FeeBasis
  fee?: number
  status?: ClientStatus
  webhook?: string
}

export interface LedgerEntry {
  id: string
  at: number
  clientId: string
  clientName: string
  store: StoreId
  sku: string
  product: string
  quantity: number
  price: number | null
  orderId: string
  fee: number
  paid: boolean
  paidAt: number | null
}

export interface ClientSummary {
  clientId: string
  name: string
  status: ClientStatus
  successes: number
  feesOwed: number
  feesPaid: number
  feesOpen: number
}

/** A user-requested download of one client's data. Passwords and cookies are not included. */
export interface ClientExport {
  client: Client
  profiles: Array<{
    id: string
    name: string
    email: string
    phone: string
    shipping: Address
    billing: Address
    cardName: string
    last4: string
    expMonth: string
    expYear: string
    clientId: string
    card: CardSecret
  }>
  accounts: Array<{ store: StoreId; label: string; username: string }>
}

export function meClient(now = 0): Client {
  return {
    id: ME_CLIENT_ID,
    name: "Me",
    contact: "",
    notes: "",
    feeBasis: "success",
    fee: 0,
    status: "active",
    webhook: "",
    createdAt: now
  }
}

export function clientIdOf(id?: string | null): string {
  const trimmed = (id ?? "").trim()
  return trimmed || ME_CLIENT_ID
}

export function clientCanStart(status: ClientStatus): boolean {
  return status === "active"
}

export function roundMoney(value: number): number {
  return Math.round(value * 100) / 100
}

/** Fee for one successful checkout. Per item multiplies by quantity. */
export function feeOwed(client: Pick<Client, "feeBasis" | "fee">, quantity: number): number {
  const fee = roundMoney(Number(client.fee) || 0)
  const units = Math.max(1, Math.round(Number(quantity)) || 1)
  if (client.feeBasis === "item") return roundMoney(fee * units)
  return fee
}

export function clientSummary(client: Pick<Client, "id" | "name" | "status">, rows: LedgerEntry[]): ClientSummary {
  const mine = rows.filter((row) => row.clientId === client.id)
  const feesOwed = roundMoney(mine.reduce((sum, row) => sum + row.fee, 0))
  const feesPaid = roundMoney(mine.filter((row) => row.paid).reduce((sum, row) => sum + row.fee, 0))
  return {
    clientId: client.id,
    name: client.name,
    status: client.status,
    successes: mine.length,
    feesOwed,
    feesPaid,
    feesOpen: roundMoney(feesOwed - feesPaid)
  }
}

export function ledgerCsv(rows: LedgerEntry[]): string {
  const header = ["client", "store", "sku", "product", "qty", "price", "order_id", "timestamp", "fee", "paid"]
  const lines = [header.join(",")]
  for (const row of rows) {
    lines.push([
      csvCell(row.clientName),
      csvCell(row.store),
      csvCell(row.sku),
      csvCell(row.product),
      String(row.quantity),
      row.price === null ? "" : row.price.toFixed(2),
      csvCell(row.orderId),
      new Date(row.at).toISOString(),
      row.fee.toFixed(2),
      row.paid ? "paid" : "open"
    ].join(","))
  }
  return `${lines.join("\n")}\n`
}

/** A success post for one client. It has no card number, CVV, or address. */
export function clientSuccessNotice(input: {
  clientName: string
  storeName: string
  sku: string
  product: string
  quantity: number
  price: number | null
  orderId?: string
  fee: number
}): Notice {
  return {
    kind: "success",
    storeName: input.storeName,
    sku: input.product || input.sku,
    profileName: input.clientName,
    detail: `Qty ${input.quantity}. Fee $${input.fee.toFixed(2)}.`,
    orderId: input.orderId,
    price: input.price
  }
}

/**
 * A proxy group belongs to one client. Direct connections are not a shared credential.
 * Returns the other client's id when the group is already taken.
 */
export function proxyGroupTakenBy(
  accounts: { id: string; clientId?: string | null; proxyGroupId: string | null }[],
  accountId: string | undefined,
  clientId: string,
  proxyGroupId: string | null
): string | null {
  if (!proxyGroupId) return null
  const owner = clientIdOf(clientId)
  const other = accounts.find((account) => account.proxyGroupId === proxyGroupId && account.id !== accountId && clientIdOf(account.clientId) !== owner)
  return other ? clientIdOf(other.clientId) : null
}

function csvCell(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`
  return value
}

const TEXT = {
  en: {
    title: "Clients",
    intro: "Each client uses their own store accounts, shipping profile, and card. A success adds the fee to their ledger. Card numbers stay encrypted on this PC.",
    name: "Name",
    contact: "Contact",
    notes: "Notes",
    fee: "Fee",
    basis: "Fee basis",
    perSuccess: "Per successful order",
    perItem: "Per item",
    status: "Status",
    active: "Active",
    paused: "Paused",
    webhook: "Success webhook",
    webhookHint: "Optional https://discord.com/api/webhooks/… URL. The post has the product, quantity, order id, and fee. It does not include the card.",
    save: "Save client",
    edit: "Edit",
    cancel: "Cancel",
    new: "New client",
    me: "Me",
    successes: "Successes",
    owed: "Fees owed",
    paid: "Fees paid",
    open: "Still open",
    ledger: "Success ledger",
    markPaid: "Mark open fees paid",
    markOne: "Mark paid",
    markUnpaid: "Mark unpaid",
    csv: "Download CSV",
    exportData: "Export this client's data",
    exportHint: "The JSON file includes this client's addresses and card numbers so you can hand the data back. Passwords and cookies stay on this PC. The CSV does not include a card.",
    deleteData: "Delete this client's data",
    deleteConfirm: "Delete this client's profiles, accounts, tasks, and ledger? The card and address data are removed from this PC.",
    filter: "Client",
    allClients: "All clients",
    empty: "No clients yet.",
    noRows: "No successful checkouts for this client yet.",
    order: "Order",
    product: "Product",
    qty: "Qty",
    price: "Price",
    when: "When"
  },
  es: {
    title: "Clientes",
    intro: "Cada cliente usa sus propias cuentas, su perfil de envío y su tarjeta. Un éxito suma la tarifa a su libro. El número de tarjeta sigue cifrado en este PC.",
    name: "Nombre",
    contact: "Contacto",
    notes: "Notas",
    fee: "Tarifa",
    basis: "Cómo se cobra",
    perSuccess: "Por pedido exitoso",
    perItem: "Por artículo",
    status: "Estado",
    active: "Activo",
    paused: "En pausa",
    webhook: "Aviso de éxito",
    webhookHint: "URL opcional https://discord.com/api/webhooks/… El aviso lleva el producto, la cantidad, el pedido y la tarifa. No incluye la tarjeta.",
    save: "Guardar cliente",
    edit: "Editar",
    cancel: "Cancelar",
    new: "Nuevo cliente",
    me: "Yo",
    successes: "Éxitos",
    owed: "Tarifas debidas",
    paid: "Tarifas pagadas",
    open: "Pendiente",
    ledger: "Libro de éxitos",
    markPaid: "Marcar pendientes como pagadas",
    markOne: "Marcar pagada",
    markUnpaid: "Marcar pendiente",
    csv: "Descargar CSV",
    exportData: "Exportar los datos de este cliente",
    exportHint: "El JSON incluye las direcciones y los números de tarjeta de este cliente para devolverle sus datos. Las contraseñas y las cookies se quedan en este PC. El CSV no incluye la tarjeta.",
    deleteData: "Borrar los datos de este cliente",
    deleteConfirm: "¿Borrar perfiles, cuentas, tareas y el libro de este cliente? La tarjeta y la dirección se eliminan de este PC.",
    filter: "Cliente",
    allClients: "Todos los clientes",
    empty: "Todavía no hay clientes.",
    noRows: "Este cliente todavía no tiene compras exitosas.",
    order: "Pedido",
    product: "Producto",
    qty: "Cant.",
    price: "Precio",
    when: "Cuándo"
  }
} as const

export type ClientTextKey = keyof typeof TEXT.en

export function clientText(lang: "en" | "es", key: ClientTextKey): string {
  return TEXT[lang][key]
}

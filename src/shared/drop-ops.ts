export type DropLang = "en" | "es"

const COPY = {
  navShip: { en: "Shipments", es: "Envíos" },
  calendarTitle: { en: "Release calendar", es: "Calendario de lanzamientos" },
  calendarIntro: {
    en: "Pokémon and One Piece dates you enter, or a JSON or ICS feed. One click creates the scheduled tasks.",
    es: "Fechas de Pokémon y One Piece que escribes, o un feed JSON o ICS. Un clic crea las tareas programadas."
  },
  game: { en: "Game", es: "Juego" },
  pokemon: { en: "Pokémon", es: "Pokémon" },
  onepiece: { en: "One Piece", es: "One Piece" },
  importFeed: { en: "JSON or ICS feed", es: "Feed JSON o ICS" },
  importButton: { en: "Import dates", es: "Importar fechas" },
  saveDate: { en: "Save date", es: "Guardar fecha" },
  createTasks: { en: "Create scheduled tasks", es: "Crear tareas programadas" },
  cloneTitle: { en: "Clone across accounts", es: "Clonar en cuentas" },
  cloneButton: { en: "Clone task", es: "Clonar tarea" },
  cloneHint: {
    en: "Each copy uses that account's sticky proxy and browser profile. The payment profile stays. A different proxy group is not copied.",
    es: "Cada copia usa el proxy fijo y el perfil del navegador de esa cuenta. El perfil de pago se queda. No se copia un grupo de proxy distinto."
  },
  allowlist: { en: "Source allowlist", es: "Lista de fuentes" },
  allowlistHint: {
    en: "One channel id, user id, or source name per line. Blank keeps the saved channels and the local webhook. A list starts tasks only from those sources.",
    es: "Un id de canal, id de usuario o nombre de fuente por línea. En blanco se quedan los canales guardados y el webhook local. Una lista solo inicia tareas de esas fuentes."
  },
  dedupe: { en: "Dedupe (minutes)", es: "Deduplicar (minutos)" },
  dedupeHint: {
    en: "The same store and SKU will not start again inside this window. 0 turns dedupe off.",
    es: "La misma tienda y SKU no vuelve a iniciar dentro de esta ventana. 0 apaga la deduplicación."
  },
  channels: { en: "Channel IDs", es: "IDs de canales" },
  channelsHint: {
    en: "One numeric channel id per line. The bot only reads channels you list.",
    es: "Un id numérico de canal por línea. El bot solo lee los canales que listas."
  },
  rehearsal: { en: "Rehearsal (minutes before)", es: "Ensayo (minutos antes)" },
  rehearsalHint: {
    en: "0 skips it. A dry run checks the session, proxy, profile, and card. It does not place an order.",
    es: "0 lo omite. Un ensayo revisa la sesión, el proxy, el perfil y la tarjeta. No hace el pedido."
  },
  accountSpend: { en: "Account daily spend", es: "Gasto diario por cuenta" },
  accountSpendHint: { en: "0 means no cap. Checked before place order.", es: "0 significa sin tope. Se revisa antes de hacer el pedido." },
  cardSpend: { en: "Card daily spend", es: "Gasto diario por tarjeta" },
  cardSpendHint: { en: "0 means no cap. Uses the card last four, not the full number.", es: "0 significa sin tope. Usa los últimos cuatro, no el número completo." },
  cardOrders: { en: "Card daily orders", es: "Pedidos diarios por tarjeta" },
  cardOrdersHint: { en: "0 means no cap. Successful orders for that last four today.", es: "0 significa sin tope. Pedidos exitosos de esos últimos cuatro hoy." },
  shipTitle: { en: "Shipments", es: "Envíos" },
  shipIntro: {
    en: "Status comes from shipping mail in the mailboxes you connected. Zzz AIO only reads that mail.",
    es: "El estado sale del correo de envío en los buzones que conectaste. Zzz AIO solo lee ese correo."
  },
  shipEmpty: { en: "No orders yet. A win with an order number shows up here.", es: "Aún no hay pedidos. Una compra con número de orden aparece aquí." },
  shipScan: { en: "Read shipping mail", es: "Leer correo de envío" },
  shipStatus: { en: "Status", es: "Estado" },
  tracking: { en: "Tracking", es: "Rastreo" },
  carrier: { en: "Carrier", es: "Transportista" },
  noOrder: { en: "No order was placed.", es: "No se hizo ningún pedido." },
  rehearsalPass: { en: "Rehearsal passed.", es: "El ensayo pasó." },
  rehearsalFail: { en: "Rehearsal found problems.", es: "El ensayo encontró problemas." }
} as const

export type DropCopyKey = keyof typeof COPY

export function dropOpsText(lang: DropLang, key: DropCopyKey): string {
  return COPY[key][lang === "es" ? "es" : "en"]
}

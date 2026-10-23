export type CheckoutLang = "en" | "es"

export function checkoutLang(language: string | undefined): CheckoutLang {
  return language === "es" ? "es" : "en"
}

export interface CheckoutCopy {
  handoff: (title: string) => string
  overCap: (cap: number) => string
  noPayment: (name: string) => string
  noPlace: (name: string) => string
  pickup: string
  notSignedIn: (name: string) => string
  needSession: (name: string) => string
  challenge: (name: string) => string
  repeated: string
  offHost: string
  stepFailed: (status: number) => string
  soldOut: string
  cartPass: string
  addressPass: string
  addressSkip: string
  shippingPass: string
  shippingSkip: string
  savedCard: string
  tokenPass: string
  accepted: (name: string, orderId: string) => string
}

export function checkoutCopy(lang: CheckoutLang): CheckoutCopy {
  if (lang === "es") {
    return {
      handoff: (title) => `${title} está disponible. La página no tiene un formulario de carrito en esta tienda. Añádelo en el navegador de la cuenta. Zzz AIO no lo añadió al carrito ni hizo el pedido.`,
      overCap: (cap) => `El precio supera el máximo de $${cap.toFixed(2)} de esta compra. No se añadió al carrito.`,
      noPayment: (name) => `${name} no muestra una tarjeta guardada de este perfil ni un formulario de pago en la tienda. El número de tarjeta no se envió.`,
      noPlace: (name) => `${name} no mostró un formulario de pedido en la tienda. El pedido no se envió.`,
      pickup: "Esta compra solo ofrece recogida en tienda. La v1 solo hace pedidos a domicilio en EE. UU.",
      notSignedIn: (name) => `The ${name} session is not signed in. La sesión de ${name} no ha iniciado sesión. Inicia sesión en Session Keeper y reanuda.`,
      needSession: (name) => `${name} tiene stock. Pega una sesión iniciada para comprar. Zzz AIO no lo añadió al carrito ni hizo el pedido.`,
      challenge: (name) => `${name} presented a challenge. Termínalo en tu navegador, pega una sesión nueva si hace falta y reanuda. Zzz AIO no resuelve desafíos.`,
      repeated: "El formulario de compra se repitió, así que el pedido no se envió.",
      offHost: "La tienda redirigió fuera de su sitio. Zzz AIO no siguió esa redirección.",
      stepFailed: (status) => `La compra devolvió HTTP ${status}. El pedido no se envió.`,
      soldOut: "La tienda dijo que no hay stock. Se vuelve al monitor.",
      cartPass: "Añadido al carrito.",
      addressPass: "Dirección de envío aceptada.",
      addressSkip: "La página de compra no pidió una dirección.",
      shippingPass: "Envío a domicilio seleccionado.",
      shippingSkip: "La página de compra no pidió un método de envío.",
      savedCard: "Se seleccionó la tarjeta guardada en la cuenta. El número de tarjeta no se envió.",
      tokenPass: "El formulario de pago de la tienda aceptó la tarjeta. No se hizo el cargo.",
      accepted: (name, orderId) => orderId ? `Pedido ${orderId}` : `${name} aceptó el pedido.`
    }
  }
  return {
    handoff: (title) => `${title} is in stock. The page has no add-to-cart form on this store, so add it in the account browser. Zzz AIO did not add it to the cart or place an order.`,
    overCap: (cap) => `The price is above this checkout's max of $${cap.toFixed(2)}. The item was not added to the cart.`,
    noPayment: (name) => `${name} checkout has no saved card matching this profile and no payment form on the store. The card number was not sent.`,
    noPlace: (name) => `${name} did not show a place-order form on the store. The order was not sent.`,
    pickup: "This checkout is offering pickup only. v1 places US ship-to-home orders only.",
    notSignedIn: (name) => `The ${name} session is not signed in. Sign in on the Session Keeper page, then resume.`,
    needSession: (name) => `${name} is in stock. Paste a signed-in session to check out. Zzz AIO did not add it to the cart or place an order.`,
    challenge: (name) => `${name} presented a challenge. Finish it in your own browser, paste a fresh session if needed, then resume. Zzz AIO does not solve challenges.`,
    repeated: "The checkout form repeated, so the order was not sent.",
    offHost: "The store redirected away from its own site. Zzz AIO did not follow that redirect.",
    stepFailed: (status) => `Checkout returned HTTP ${status}. The order was not sent.`,
    soldOut: "The store said the item is out of stock. Returning to the monitor.",
    cartPass: "Added the item to the cart.",
    addressPass: "Shipping address accepted.",
    addressSkip: "The checkout page did not ask for an address.",
    shippingPass: "Ship-to-home selected.",
    shippingSkip: "The checkout page did not ask for a shipping method.",
    savedCard: "The saved card on the account was selected. The card number was not sent.",
    tokenPass: "The store's payment form accepted the card. The card was not charged.",
    accepted: (name, orderId) => orderId ? `Order ${orderId}` : `${name} accepted the shipping order.`
  }
}

export function pageHandoff(title: string, lang: CheckoutLang = "en"): string {
  return checkoutCopy(lang).handoff(title)
}

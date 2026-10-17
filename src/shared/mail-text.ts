import { MAIL_PRESETS, type MailLang, type MailProvider } from "./mail"

export interface MailGuide {
  steps: string[]
  links: { label: string; href: string }[]
}

const TEXT = {
  en: {
    title: "Mail",
    intro: "Type your email and TCGAIO fills the server. Google and Microsoft can sign in without an app password. iCloud and Yahoo use an app password. Mail is read-only and only messages from the store are used.",
    language: "Language",
    add: "Add mailbox",
    edit: "Edit",
    remove: "Remove",
    none: "No mailboxes yet.",
    email: "Email",
    emailHint: "The address that receives store mail.",
    detected: "Detected",
    guessed: "This domain is not a known provider. The server is a guess. Change it if the test fails.",
    provider: "Provider",
    name: "Name",
    host: "Host",
    port: "Port",
    ssl: "SSL/TLS. On uses port 993. Off uses STARTTLS and will not send the password unless the server upgrades.",
    username: "Username",
    appPassword: "App password",
    appPasswordHint: "Leave blank to keep the saved password. Not needed after Sign in with Google or Microsoft.",
    folder: "Folder",
    folderHint: "Test the connection to load the list.",
    folderName: "Folder name",
    codes: "Sign-in codes. Fill a verification code from this mailbox into your own store sign-in.",
    orders: "Order mail. Read confirmation, shipping, and cancellation messages.",
    alerts: "Restock and newsletter alerts. Optional. A match notifies you and does not start checkout.",
    enabled: "Use this mailbox.",
    save: "Save mailbox",
    test: "Test connection",
    close: "Close",
    signInGoogle: "Sign in with Google",
    signInMicrosoft: "Sign in with Microsoft",
    signedIn: "Signed in. The refresh token stays encrypted on this PC.",
    saved: "Mailbox saved. The secret stays on this PC.",
    removed: "Mailbox removed.",
    connected: "Connected.",
    connectedFolders: "Connected. Folders loaded.",
    on: "On",
    off: "Off",
    oauth: "Signed in",
    password: "App password",
    clientGoogle: "Google client ID",
    clientMicrosoft: "Microsoft client ID",
    clientHint: "Public desktop client ID, saved on this PC. Leave blank if you use an app password. Sign in opens the browser once this is set.",
    saveClients: "Save sign-in IDs",
    clientsSaved: "Sign-in IDs saved.",
    openLink: "Open",
    steps: "How to create the app password",
    instead: "Or use an app password",
    phoneTitle: "Mail",
    phoneIntro: "Add the mailbox that receives your store mail. Sign-in for Google and Microsoft opens on the PC.",
    phoneSave: "Save on PC",
    phoneBack: "Back",
    statusOff: "Mail is off. Add a mailbox here or in desktop Settings.",
    statusOn: "Mail"
  },
  es: {
    title: "Correo",
    intro: "Escribe tu correo y TCGAIO completa el servidor. Google y Microsoft pueden entrar sin contraseña de aplicación. iCloud y Yahoo usan una contraseña de aplicación. El acceso es de solo lectura y solo cuenta el correo de la tienda.",
    language: "Idioma",
    add: "Añadir buzón",
    edit: "Editar",
    remove: "Quitar",
    none: "Todavía no hay buzones.",
    email: "Correo",
    emailHint: "La dirección que recibe el correo de la tienda.",
    detected: "Detectado",
    guessed: "Ese dominio no es un proveedor conocido. El servidor es una suposición. Cámbialo si la prueba falla.",
    provider: "Proveedor",
    name: "Nombre",
    host: "Servidor",
    port: "Puerto",
    ssl: "SSL/TLS. Activado usa el puerto 993. Desactivado usa STARTTLS y no envía la contraseña si el servidor no cifra.",
    username: "Usuario",
    appPassword: "Contraseña de aplicación",
    appPasswordHint: "Déjalo en blanco para conservar la contraseña guardada. No hace falta después de iniciar sesión con Google o Microsoft.",
    folder: "Carpeta",
    folderHint: "Prueba la conexión para cargar la lista.",
    folderName: "Nombre de la carpeta",
    codes: "Códigos de acceso. Rellena el código de verificación de este buzón en tu propia cuenta de la tienda.",
    orders: "Correo de pedidos. Lee confirmaciones, envíos y cancelaciones.",
    alerts: "Avisos de reposición y boletines. Opcional. Un aviso te avisa y no inicia la compra.",
    enabled: "Usar este buzón.",
    save: "Guardar buzón",
    test: "Probar conexión",
    close: "Cerrar",
    signInGoogle: "Iniciar sesión con Google",
    signInMicrosoft: "Iniciar sesión con Microsoft",
    signedIn: "Sesión iniciada. El token de renovación queda cifrado en este PC.",
    saved: "Buzón guardado. El secreto queda en este PC.",
    removed: "Buzón quitado.",
    connected: "Conectado.",
    connectedFolders: "Conectado. Carpetas cargadas.",
    on: "Activo",
    off: "Inactivo",
    oauth: "Sesión iniciada",
    password: "Contraseña de aplicación",
    clientGoogle: "ID de cliente de Google",
    clientMicrosoft: "ID de cliente de Microsoft",
    clientHint: "ID público de cliente de escritorio, guardado en este PC. Déjalo en blanco si usas una contraseña de aplicación. Iniciar sesión abre el navegador cuando este dato existe.",
    saveClients: "Guardar IDs",
    clientsSaved: "IDs de inicio de sesión guardados.",
    openLink: "Abrir",
    steps: "Cómo crear la contraseña de aplicación",
    instead: "O usa una contraseña de aplicación",
    phoneTitle: "Correo",
    phoneIntro: "Añade el buzón que recibe el correo de tus tiendas. El inicio de sesión de Google y Microsoft se abre en el PC.",
    phoneSave: "Guardar en el PC",
    phoneBack: "Volver",
    statusOff: "El correo está apagado. Añade un buzón aquí o en Ajustes del PC.",
    statusOn: "Correo"
  }
} as const

export type MailTextKey = keyof typeof TEXT.en

export function mailText(lang: MailLang, key: MailTextKey): string {
  return TEXT[lang][key] ?? TEXT.en[key]
}

export function mailGuide(provider: MailProvider, lang: MailLang): MailGuide {
  const es = lang === "es"
  if (provider === "icloud") {
    return {
      steps: es
        ? [
            "Abre el Apple ID e inicia sesión.",
            "Elige Inicio de sesión y seguridad, luego Contraseñas específicas de apps.",
            "Crea una contraseña llamada TCGAIO.",
            "Pégala aquí. El usuario es tu correo completo de iCloud."
          ]
        : [
            "Open your Apple ID and sign in.",
            "Choose Sign-In and Security, then App-Specific Passwords.",
            "Create a password named TCGAIO.",
            "Paste it here. The username is your full iCloud email."
          ],
      links: [{ label: es ? "Abrir Apple ID" : "Open Apple ID", href: "https://appleid.apple.com/account/manage" }]
    }
  }
  if (provider === "yahoo") {
    return {
      steps: es
        ? [
            "Abre la seguridad de la cuenta de Yahoo.",
            "Genera una contraseña de aplicación.",
            "Pégala aquí. El usuario es tu correo completo de Yahoo."
          ]
        : [
            "Open Yahoo account security.",
            "Generate an app password.",
            "Paste it here. The username is your full Yahoo email."
          ],
      links: [{ label: es ? "Seguridad de Yahoo" : "Yahoo security", href: "https://login.yahoo.com/account/security" }]
    }
  }
  if (provider === "gmail") {
    return {
      steps: es
        ? [
            "Iniciar sesión con Google es el camino más corto.",
            "Si prefieres una contraseña de aplicación, actívala en la cuenta de Google, en Seguridad.",
            "Activa IMAP en los ajustes de Gmail.",
            `Servidor ${MAIL_PRESETS.gmail.host}, puerto ${MAIL_PRESETS.gmail.port}, SSL.`
          ]
        : [
            "Sign in with Google is the short path.",
            "If you prefer an app password, create one in the Google account under Security.",
            "Turn IMAP on in Gmail settings.",
            `Server ${MAIL_PRESETS.gmail.host}, port ${MAIL_PRESETS.gmail.port}, SSL.`
          ],
      links: [
        { label: es ? "Contraseñas de aplicación" : "App passwords", href: "https://myaccount.google.com/apppasswords" },
        { label: es ? "Crear ID de cliente" : "Create a client ID", href: "https://console.cloud.google.com/apis/credentials" }
      ]
    }
  }
  if (provider === "outlook") {
    return {
      steps: es
        ? [
            "Iniciar sesión con Microsoft es el camino más corto.",
            "Si la cuenta lo permite, crea una contraseña de aplicación en Seguridad.",
            `Servidor ${MAIL_PRESETS.outlook.host}, puerto ${MAIL_PRESETS.outlook.port}, SSL.`
          ]
        : [
            "Sign in with Microsoft is the short path.",
            "If the account allows it, create an app password under Security.",
            `Server ${MAIL_PRESETS.outlook.host}, port ${MAIL_PRESETS.outlook.port}, SSL.`
          ],
      links: [
        { label: es ? "Contraseña de aplicación" : "App password", href: "https://account.live.com/proofs/AppPassword" },
        { label: es ? "Crear ID de cliente" : "Create a client ID", href: "https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps/ApplicationsListBlade" }
      ]
    }
  }
  return {
    steps: es
      ? ["Usa el servidor y el puerto que te dio tu proveedor.", "El puerto 993 va con SSL/TLS activado."]
      : ["Use the host and port from your provider.", "Port 993 belongs with SSL/TLS on."],
    links: []
  }
}

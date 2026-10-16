import type { ReactNode } from "react"

export function Field({ label, hint, children, className = "" }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return (
    <label className={`field ${className}`.trim()}>
      <span>{label}</span>
      {children}
      {hint ? <small>{hint}</small> : null}
    </label>
  )
}

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} />
}

export function Select(props: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select {...props} />
}

export function Banner({ tone, children }: { tone: "error" | "info"; children: ReactNode }) {
  return <div className={`banner ${tone}`} role={tone === "error" ? "alert" : "status"}>{children}</div>
}

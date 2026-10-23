import { useCallback, useId, useRef, useState } from "react"
import { Popover } from "./Popover"

export interface RowMenuItem { label: string; run: () => void; danger?: boolean; disabled?: boolean }

/** "⋯" menu rendered in a portal so table/card overflow never clips it. */
export function RowMenu({ label, items }: { label: string; items: RowMenuItem[] }) {
  const [open, setOpen] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const id = useId()
  const close = useCallback(() => setOpen(false), [])
  return (
    <span className="row-menu">
      <button type="button" ref={button} className="row-menu-button" aria-label={`More actions for ${label}`} aria-haspopup="menu" aria-expanded={open} aria-controls={id} onClick={() => setOpen((on) => !on)}>⋯</button>
      <Popover anchor={button} open={open} onClose={close} align="right" className="row-menu-list" role="menu" id={id} label={`Actions for ${label}`}>
        {items.map((item) => (
          <button key={item.label} type="button" role="menuitem" className={item.danger ? "danger" : undefined} disabled={item.disabled} onClick={() => { setOpen(false); item.run() }}>{item.label}</button>
        ))}
      </Popover>
    </span>
  )
}

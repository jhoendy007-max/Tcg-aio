import { useCallback, useEffect, useId, useRef, useState } from "react"
import { Popover } from "./Popover"
import { StoreLogo } from "./StoreLogo"

export interface StoreChoice {
  id: string
  name: string
  implemented?: boolean
}

/** Glass store dropdown with logos. Keyboard: Enter/Space/arrows open, arrows move, Enter picks, Esc closes, letters jump. */
export function StoreSelect({ value, stores, disabled, onChange, label = "Store" }: { value: string; stores: StoreChoice[]; disabled?: boolean; onChange: (id: string) => void; label?: string }) {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const close = useCallback(() => setOpen(false), [])
  const list = useRef<HTMLUListElement>(null)
  const id = useId()
  const current = stores.find((store) => store.id === value)
  const selectedIndex = Math.max(0, stores.findIndex((store) => store.id === value))


  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [open, active])

  function pick(index: number) {
    const store = stores[index]
    if (!store) return
    onChange(store.id)
    setOpen(false)
  }

  function onKey(event: React.KeyboardEvent) {
    if (disabled) return
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) {
        event.preventDefault()
        setActive(selectedIndex)
        setOpen(true)
      }
      return
    }
    if (event.key === "Escape") { event.preventDefault(); setOpen(false) }
    else if (event.key === "ArrowDown") { event.preventDefault(); setActive((index) => Math.min(stores.length - 1, index + 1)) }
    else if (event.key === "ArrowUp") { event.preventDefault(); setActive((index) => Math.max(0, index - 1)) }
    else if (event.key === "Home") { event.preventDefault(); setActive(0) }
    else if (event.key === "End") { event.preventDefault(); setActive(stores.length - 1) }
    else if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(active) }
    else if (event.key === "Tab") setOpen(false)
    else if (/^[a-z0-9]$/i.test(event.key)) {
      const key = event.key.toLowerCase()
      const next = stores.findIndex((store, index) => index > active && store.name.toLowerCase().startsWith(key))
      const found = next >= 0 ? next : stores.findIndex((store) => store.name.toLowerCase().startsWith(key))
      if (found >= 0) setActive(found)
    }
  }

  return (
    <div className={open ? "store-select open" : "store-select"} ref={root}>
      <button
        type="button"
        ref={button}
        className="store-select-button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        aria-label={`${label}: ${current?.name ?? value}`}
        aria-activedescendant={open ? `${id}-${active}` : undefined}
        disabled={disabled}
        onClick={() => { setActive(selectedIndex); setOpen((on) => !on) }}
        onKeyDown={onKey}
      >
        <StoreLogo store={value} size={26} withName label={current?.name} />
        <span className="store-select-caret" aria-hidden="true">▾</span>
      </button>
      <Popover anchor={button} open={open} onClose={close} matchWidth className="store-select-pop">
        <ul className="store-select-list" role="listbox" id={`${id}-list`} ref={list} aria-label={label}>
          {stores.map((store, index) => (
            <li
              key={store.id}
              id={`${id}-${index}`}
              data-index={index}
              role="option"
              aria-selected={store.id === value}
              className={index === active ? "active" : undefined}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => { event.preventDefault(); pick(index) }}
            >
              <StoreLogo store={store.id} size={26} withName label={store.name} />
              {store.implemented === false ? <span className="stub">soon</span> : null}
            </li>
          ))}
        </ul>
      </Popover>
    </div>
  )
}

import { useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react"
import { createPortal } from "react-dom"

export interface PlaceInput {
  anchor: { top: number; bottom: number; left: number; right: number; width: number }
  pop: { width: number; height: number }
  viewport: { width: number; height: number }
  align?: "left" | "right"
  gap?: number
  margin?: number
}

/** Where a popover goes: below the anchor, or above it when there is no room below; kept inside the viewport. */
export function placePopover({ anchor, pop, viewport, align = "left", gap = 6, margin = 8 }: PlaceInput): { top: number; left: number; flipped: boolean; maxHeight: number } {
  const below = viewport.height - anchor.bottom - gap - margin
  const above = anchor.top - gap - margin
  const flipped = pop.height > below && above > below
  const maxHeight = Math.max(80, flipped ? above : below)
  const height = Math.min(pop.height, maxHeight)
  const top = flipped ? anchor.top - gap - height : anchor.bottom + gap
  let left = align === "right" ? anchor.right - pop.width : anchor.left
  left = Math.min(Math.max(margin, left), Math.max(margin, viewport.width - margin - pop.width))
  return { top, left, flipped, maxHeight }
}

/** Renders children in document.body with fixed positioning so no overflow container can clip it. */
export function Popover({ anchor, open, onClose, align = "left", matchWidth = false, className = "", children, role, id, label }: {
  anchor: RefObject<HTMLElement | null>
  open: boolean
  onClose: () => void
  align?: "left" | "right"
  matchWidth?: boolean
  className?: string
  children: ReactNode
  role?: string
  id?: string
  label?: string
}) {
  const box = useRef<HTMLDivElement>(null)
  const [style, setStyle] = useState<CSSProperties>({ position: "fixed", top: -9999, left: -9999, visibility: "hidden" })

  useLayoutEffect(() => {
    if (!open) return
    const place = () => {
      const a = anchor.current?.getBoundingClientRect()
      const el = box.current
      if (!a || !el) return
      const width = matchWidth ? a.width : el.offsetWidth
      const spot = placePopover({ anchor: a, pop: { width, height: el.scrollHeight }, viewport: { width: window.innerWidth, height: window.innerHeight }, align })
      setStyle({ position: "fixed", top: spot.top, left: spot.left, maxHeight: spot.maxHeight, width: matchWidth ? a.width : undefined, visibility: "visible" })
      el.dataset.flipped = spot.flipped ? "true" : "false"
    }
    place()
    const outside = (event: MouseEvent) => {
      const target = event.target as Node
      if (box.current?.contains(target) || anchor.current?.contains(target)) return
      onClose()
    }
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose() }
    window.addEventListener("resize", place)
    window.addEventListener("scroll", place, true)
    document.addEventListener("mousedown", outside)
    document.addEventListener("keydown", key)
    return () => {
      window.removeEventListener("resize", place)
      window.removeEventListener("scroll", place, true)
      document.removeEventListener("mousedown", outside)
      document.removeEventListener("keydown", key)
    }
  }, [open, anchor, align, matchWidth, onClose])

  if (!open) return null
  return createPortal(
    <div ref={box} className={`popover ${className}`.trim()} style={style} role={role} id={id} aria-label={label}>{children}</div>,
    document.body
  )
}

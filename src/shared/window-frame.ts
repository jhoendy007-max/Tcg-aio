export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

export interface FrameChoice {
  bounds: Frame
  /** First launch on a small display uses the work area instead of a floating window. */
  maximize: boolean
}

const MIN = { width: 1024, height: 640 }

/**
 * Electron work-area sizes are already in DIP, so DPI scaling is left to the OS.
 * The window stays inside the work area and never grows past it.
 */
export function chooseWindowFrame(work: Frame, saved: Frame | null): FrameChoice {
  if (!saved) {
    const tight = work.width < 1400 || work.height < 860
    if (tight) return { bounds: clamp(work, work), maximize: true }
    const width = Math.round(Math.min(work.width * 0.92, 1600))
    const height = Math.round(Math.min(work.height * 0.9, 1000))
    return {
      maximize: false,
      bounds: clamp({
        x: work.x + Math.round((work.width - width) / 2),
        y: work.y + Math.round((work.height - height) / 2),
        width,
        height
      }, work)
    }
  }
  return { maximize: false, bounds: clamp(saved, work) }
}

function clamp(frame: Frame, work: Frame): Frame {
  const width = Math.min(Math.max(frame.width, Math.min(MIN.width, work.width)), work.width)
  const height = Math.min(Math.max(frame.height, Math.min(MIN.height, work.height)), work.height)
  const maxX = work.x + work.width - width
  const maxY = work.y + work.height - height
  return {
    x: Math.min(Math.max(frame.x, work.x), Math.max(work.x, maxX)),
    y: Math.min(Math.max(frame.y, work.y), Math.max(work.y, maxY)),
    width,
    height
  }
}

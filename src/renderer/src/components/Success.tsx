import type { PublicTask, StoreId } from "../../../shared/types"
import { storeName } from "../../../shared/stores"
import { ProductVisual } from "./marks"

export interface WinCard {
  task: PublicTask
  price: number | null
  orderId: string
}

export function SuccessScreen({ win, sound, onSound, onClose }: { win: WinCard; sound: boolean; onSound: (on: boolean) => void; onClose: () => void }) {
  const tested = win.task.status === "tested"
  return (
    <div className="success-scrim" role="dialog" aria-modal="true" aria-labelledby="success-title">
      <div className="success-card">
        <ProductVisual store={win.task.store as StoreId} name={storeName(win.task.store)} sku={win.task.sku} imageUrl={win.task.imageUrl} size={96} />
        <p className="success-kicker">{tested ? "Test finished" : "Checkout confirmed"}</p>
        <h2 id="success-title">{storeName(win.task.store)}</h2>
        <p className="success-sku">{win.task.sku}</p>
        <p className="success-price">{win.price === null ? "Price not recorded" : `$${win.price.toFixed(2)}`}</p>
        <p>{tested ? "Place order was not sent." : win.orderId ? `Order ${win.orderId}` : "Order number was not on the receipt."}</p>
        <label className="check">
          <input type="checkbox" checked={sound} onChange={(event) => onSound(event.target.checked)} />
          <span>Play a sound on checkout</span>
        </label>
        <button type="button" className="primary" onClick={onClose}>Close</button>
      </div>
    </div>
  )
}

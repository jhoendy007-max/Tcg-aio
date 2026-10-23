import amazon from "../assets/stores/amazon.png"
import bandai from "../assets/stores/bandai.png"
import barnesNoble from "../assets/stores/barnes-noble.png"
import bestbuy from "../assets/stores/bestbuy.png"
import costco from "../assets/stores/costco.png"
import crunchyroll from "../assets/stores/crunchyroll.png"
import gamestop from "../assets/stores/gamestop.png"
import pokemonCenter from "../assets/stores/pokemon-center.png"
import sams from "../assets/stores/sams.png"
import target from "../assets/stores/target.png"
import tcgplayer from "../assets/stores/tcgplayer.png"
import walmart from "../assets/stores/walmart.png"
import { storeName } from "../../../shared/stores"

/** Small bundled store marks (local files, never hotlinked). */
export const STORE_LOGOS: Record<string, string> = {
  amazon,
  bandai,
  "barnes-noble": barnesNoble,
  bestbuy,
  costco,
  crunchyroll,
  gamestop,
  "pokemon-center": pokemonCenter,
  sams,
  target,
  tcgplayer,
  walmart
}

export function StoreLogo({ store, size = 26, withName = false }: { store: string; size?: number; withName?: boolean }) {
  const src = STORE_LOGOS[store]
  const name = storeName(store as never) || store
  return (
    <span className="store-logo-wrap">
      <span className="store-logo" style={{ width: size, height: size }} title={name}>
        {src ? <img src={src} alt="" width={size - 8} height={size - 8} /> : <span className="store-letter">{name.slice(0, 1).toUpperCase()}</span>}
      </span>
      {withName ? <span className="store-logo-name">{name}</span> : null}
    </span>
  )
}

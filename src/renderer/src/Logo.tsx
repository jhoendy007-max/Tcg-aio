import logo from "./assets/zzz-logo.png"

export const LOGO_URL = logo

export function ZzzLogo({ size = 28, className = "" }: { size?: number; className?: string }) {
  return <img className={`zzz-logo ${className}`.trim()} src={logo} width={size} height={size} alt="" aria-hidden="true" />
}

export function BrandLockup({ size = 44 }: { size?: number }) {
  return (
    <div className="brand-lockup">
      <ZzzLogo size={size} />
      <div><strong>Zzz AIO</strong><span>Cop while you sleep</span></div>
    </div>
  )
}

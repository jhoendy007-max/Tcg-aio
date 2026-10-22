import { useState } from "react"
import { ClientsPage } from "./Clients"

const STEPS = ["Client", "Store and product", "Profile and shipping", "Confirm"] as const

export function AcoPage({ unlocked, advanced }: { unlocked: boolean; advanced: boolean }) {
  const [step, setStep] = useState(0)
  const [started, setStarted] = useState(false)

  return (
    <section className="page">
      <header className="page-head">
        <div>
          <h1>ACO</h1>
          <p>Add a client, pick the product, choose where it ships, then confirm.</p>
        </div>
      </header>
      {unlocked ? null : (
        <div className="card lock-note">
          <strong>ACO is locked on this license.</strong>
          <p>The section stays here. A license with ACO opens it on the next check-in.</p>
        </div>
      )}
      {!started ? (
        <div className="card">
          <h2>Add your first ACO client</h2>
          <p>A client is the person this checkout is for.</p>
          <button type="button" className="primary" disabled={!unlocked} onClick={() => setStarted(true)}>Add your first ACO client</button>
        </div>
      ) : (
        <div className="card">
          <ol className="aco-steps">
            {STEPS.map((label, index) => (
              <li key={label}>
                <button type="button" disabled={!unlocked} aria-current={index === step ? "step" : undefined} onClick={() => setStep(index)}>{index + 1}. {label}</button>
              </li>
            ))}
          </ol>
          <p>{STEPS[step]}. Finish this step, then continue.</p>
          <div className="actions">
            <button type="button" disabled={!unlocked || step === 0} onClick={() => setStep((value) => Math.max(0, value - 1))}>Back</button>
            <button type="button" className="primary" disabled={!unlocked || step === STEPS.length - 1} onClick={() => setStep((value) => Math.min(STEPS.length - 1, value + 1))}>Continue</button>
          </div>
        </div>
      )}
      <details className="advanced" open={advanced}>
        <summary>Advanced</summary>
        {unlocked ? <ClientsPage /> : <p>Client records stay hidden until ACO is on this license.</p>}
      </details>
    </section>
  )
}

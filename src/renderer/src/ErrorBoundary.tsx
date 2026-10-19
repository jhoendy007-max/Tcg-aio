import { Component, type ReactNode } from "react"

type Props = { children: ReactNode }
type State = { error: string; attempt: number }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: "", attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    console.error(error)
    return { error: error instanceof Error ? error.message : "Something went wrong." }
  }

  componentDidCatch(error: unknown): void {
    console.error(error)
  }

  render() {
    if (!this.state.error) return <div key={this.state.attempt}>{this.props.children}</div>
    return (
      <main style={{ minHeight: "100%", background: "#0e1116", color: "#f2f5f8", padding: 32, fontFamily: "Segoe UI, sans-serif" }}>
        <p style={{ color: "#e0b15a", fontWeight: 800, letterSpacing: "0.12em" }}>TCGAIO</p>
        <h1 style={{ fontSize: 28 }}>Something went wrong</h1>
        <p style={{ color: "#93a0b5" }}>{this.state.error}</p>
        <button type="button" onClick={() => this.setState((current) => ({ error: "", attempt: current.attempt + 1 }))} style={{ background: "#e0b15a", color: "#1c1508", border: 0, borderRadius: 12, padding: "10px 16px", fontWeight: 800 }}>Retry</button>
      </main>
    )
  }
}

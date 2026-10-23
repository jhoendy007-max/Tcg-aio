import { Component, type ReactNode } from "react"
import { Pressable, Text, View } from "react-native"

type Props = { children: ReactNode }
type State = { error: string; attempt: number }

export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: "", attempt: 0 }

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { error: error instanceof Error ? error.message : "Something went wrong." }
  }

  componentDidCatch(error: unknown): void {
    console.error(error)
  }

  render() {
    if (!this.state.error) return <View key={this.state.attempt} style={{ flex: 1 }}>{this.props.children}</View>
    return (
      <View style={{ flex: 1, backgroundColor: "#0e1116", padding: 24, paddingTop: 72, gap: 12 }}>
        <Text style={{ color: "#8b5cf6", fontWeight: "800", letterSpacing: 1 }}>Zzz AIO</Text>
        <Text style={{ color: "#f2f5f8", fontSize: 22, fontWeight: "700" }}>Something went wrong</Text>
        <Text style={{ color: "#93a0b5", fontSize: 15 }}>{this.state.error}</Text>
        <Pressable
          onPress={() => this.setState((current) => ({ error: "", attempt: current.attempt + 1 }))}
          style={{ backgroundColor: "#8b5cf6", borderRadius: 12, paddingVertical: 12, alignItems: "center" }}
        >
          <Text style={{ color: "#1c1508", fontWeight: "800" }}>Retry</Text>
        </Pressable>
      </View>
    )
  }
}

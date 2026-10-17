import { useRef, type ReactNode } from "react"
import { Animated, PanResponder, Text, View } from "react-native"

export function SwipeTask({ children, active, onPrimary, onTest }: {
  children: ReactNode
  active: boolean
  onPrimary: () => void
  onTest: () => void
}) {
  const pan = useRef(new Animated.Value(0)).current
  const responder = useRef(PanResponder.create({
    onMoveShouldSetPanResponder: (_, gesture) => Math.abs(gesture.dx) > 18 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.4,
    onPanResponderMove: (_, gesture) => {
      pan.setValue(Math.max(-120, Math.min(120, gesture.dx)))
    },
    onPanResponderTerminationRequest: () => false,
    onPanResponderRelease: (_, gesture) => {
      if (gesture.dx > 72) onPrimary()
      else if (gesture.dx < -72) onTest()
      Animated.spring(pan, { toValue: 0, useNativeDriver: true, speed: 20, bounciness: 0 }).start()
    }
  })).current

  return (
    <View>
      <View style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0, flexDirection: "row", justifyContent: "space-between", alignItems: "center", paddingHorizontal: 16 }} accessibilityElementsHidden>
        <Text>{active ? "Stop" : "Start"}</Text>
        <Text>Test</Text>
      </View>
      <Animated.View style={{ transform: [{ translateX: pan }] }} {...responder.panHandlers}>
        {children}
      </Animated.View>
    </View>
  )
}

import "react-native-get-random-values"
import { registerRootComponent } from "expo"
import App from "./App"
import { keepLicenseBuild } from "./src/license-build"

keepLicenseBuild()
registerRootComponent(App)

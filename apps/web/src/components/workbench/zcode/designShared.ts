/** Design 既有共享叶子的编译入口；保留原组件，避免 Next 装载声明或改变 Code 文档隔离。 */

export {
  HoverCard,
  HoverCardContent,
  HoverCardTrigger,
} from "./components/ui/hover-card.js";
export { TooltipProvider } from "./components/ui/tooltip.js";
export { PlatformProvider } from "./hooks/usePlatform.js";
export { ServiceProvider } from "./hooks/useServices.js";
export { CodeHttpChannelClient } from "./host/httpChannelClient.js";
export { createWebPlatform } from "./host/upstream/browserPlatform.js";
export { ZCodeIntlProvider } from "./i18n/IntlProvider.js";
export { ChatPromptEditor } from "./prompt-editor/ChatPromptEditor.js";
export { TabStoreProvider } from "./store/TabStoreProvider.js";
export { WorkbenchModeNavigation } from "./host/WorkbenchModeNavigation.js";

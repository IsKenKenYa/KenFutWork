// side-pane-full-view 模块公开入口（spec：docs/ui/side-pane-full-view.md）。
export type * from "@zui/side-pane-full-view/contract.js";
export { SidePaneFullViewConversationHost } from "@zui/side-pane-full-view/ConversationHost.js";
export {
  SIDE_PANE_FULL_VIEW_CONVERSATION_TAB_VALUE,
  SidePaneFullViewConversationTab,
} from "@zui/side-pane-full-view/ConversationTab.js";
export { SidePaneFullViewToggleButton } from "@zui/side-pane-full-view/ToggleButton.js";
export { useSidePaneFullView } from "@zui/side-pane-full-view/useSidePaneFullView.js";
export {
  readFloatingAnchorPreference,
  writeFloatingAnchorPreference,
} from "@zui/side-pane-full-view/anchorPreference.js";
export { useConversationPanePresentation } from "@zui/side-pane-full-view/conversationPanePresentation.js";

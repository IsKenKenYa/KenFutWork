import type { ConversationWorkContext } from "@zcode/shared/zcode-protocol-v4";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react";

export interface ComposerContextHeaderProps {
  workspacePath: string;
  workspaceIdentity?: string;
  contextOverride?: ConversationWorkContext;
  onChangeContext: (context: ConversationWorkContext | undefined) => void;
}
const Context = createContext<ComponentType<ComposerContextHeaderProps> | null>(
  null,
);
export function ComposerContextProvider({
  renderer,
  children,
}: {
  renderer: ComponentType<ComposerContextHeaderProps>;
  children: ReactNode;
}) {
  return <Context.Provider value={renderer}>{children}</Context.Provider>;
}
export function ComposerContextHeader(props: ComposerContextHeaderProps) {
  const Renderer = useContext(Context);
  return Renderer ? <Renderer {...props} /> : null;
}

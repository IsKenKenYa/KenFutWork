import type { ToolCallBlockRenderContext } from "@zui/ToolCallBlocks/shared.js";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react";

/** 宿主插件贡献展示组件；原工具身份、状态和错误仍由同一个工具卡上下文持有。 */
export interface ToolCallRendererContribution {
  id: string;
  matches: (context: ToolCallBlockRenderContext) => boolean;
  component: ComponentType<ToolCallBlockRenderContext>;
}
const EMPTY_RENDERERS: readonly ToolCallRendererContribution[] = [];
const Contributions = createContext(EMPTY_RENDERERS);
export function ToolCallRendererProvider({
  renderers,
  children,
}: {
  renderers: readonly ToolCallRendererContribution[];
  children: ReactNode;
}) {
  return (
    <Contributions.Provider value={renderers}>
      {children}
    </Contributions.Provider>
  );
}
export const useToolCallRendererContributions = () => useContext(Contributions);

export function resolveContributedToolCallRenderer(
  context: ToolCallBlockRenderContext,
  renderers: readonly ToolCallRendererContribution[],
) {
  return renderers.find((renderer) => renderer.matches(context))?.component;
}

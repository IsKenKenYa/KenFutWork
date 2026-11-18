import { TabsContent } from "@zui/components/ui/tabs.js";
import type { DocumentSidePaneTab } from "@zui/lib/workspaceSidePane.js";
import {
  type ComponentType,
  createContext,
  type ReactNode,
  useContext,
} from "react";

export interface DocumentPaneRendererProps {
  tab: DocumentSidePaneTab;
  isVisible: boolean;
  workspaceAbsPath: string;
  workspaceIdentity?: string;
  activeTaskId: string | null;
}

export interface DocumentPaneRendererDefinition {
  resourceType: DocumentSidePaneTab["resourceType"];
  component: ComponentType<DocumentPaneRendererProps>;
}

const DocumentRenderers = createContext<
  readonly DocumentPaneRendererDefinition[]
>([]);

export function DocumentPaneRendererProvider({
  renderers,
  children,
}: {
  renderers: readonly DocumentPaneRendererDefinition[];
  children: ReactNode;
}) {
  return (
    <DocumentRenderers.Provider value={renderers}>
      {children}
    </DocumentRenderers.Provider>
  );
}

/** 文档消费方只按资源类型查找宿主贡献，不依赖具体画布实现。 */
export function DocumentPane(props: DocumentPaneRendererProps) {
  const renderers = useContext(DocumentRenderers);
  const renderer = renderers.find(
    (candidate) => candidate.resourceType === props.tab.resourceType,
  );
  if (!renderer) {
    return <div role="alert">无法打开文档，请检查对应插件</div>;
  }
  const Renderer = renderer.component;
  return <Renderer {...props} />;
}

export function DocumentSidePaneContent(props: DocumentPaneRendererProps) {
  return (
    <TabsContent
      value={props.tab.id}
      forceMount
      hidden={!props.isVisible}
      inert={!props.isVisible}
      className="relative z-10 h-full min-h-0 bg-background data-[state=inactive]:hidden"
    >
      <DocumentPane {...props} />
    </TabsContent>
  );
}

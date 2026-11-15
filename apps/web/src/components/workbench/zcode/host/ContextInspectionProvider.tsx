import { ScopedErrorBoundary } from "@zui/ErrorBoundary.js";
import {
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useRef,
  useState,
} from "react";
import type { InspectionCall } from "./contextInspectionReader.js";
import type { CodeHttpChannelClient } from "./httpChannelClient.js";

const Inspector = lazy(() => import("./ContextInspectionDialog.js"));
const OpenContext = createContext<((taskId: string) => void) | null>(null);
export const useOpenContextInspection = () => useContext(OpenContext);

export function ContextInspectionProvider({
  client,
  children,
}: {
  client: CodeHttpChannelClient;
  children: ReactNode;
}) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const background = useRef<HTMLDivElement>(null);
  const call = useCallback<InspectionCall>(
    (method, args) => client.getChannel("context-insights").call(method, args),
    [client],
  );
  return (
    <OpenContext.Provider
      value={(id) => {
        setFailed(false);
        setTaskId(id);
      }}
    >
      <div ref={background} style={{ display: "contents" }}>
        {children}
      </div>
      {taskId && failed ? (
        <div role="alert" className="context-inspection-loading">
          <p>分析界面加载失败</p>
          <button type="button" onClick={() => setTaskId(null)}>
            关闭分析
          </button>
        </div>
      ) : null}
      {taskId && !failed ? (
        <ScopedErrorBoundary
          scope="context-inspection"
          variant="silent"
          onCaughtReactError={() => setFailed(true)}
        >
          <Suspense
            fallback={
              <p role="status" className="context-inspection-loading">
                读取上下文分析…
              </p>
            }
          >
            <Inspector
              key={taskId}
              taskId={taskId}
              background={background}
              call={call}
              onClose={() => setTaskId(null)}
            />
          </Suspense>
        </ScopedErrorBoundary>
      ) : null}
    </OpenContext.Provider>
  );
}

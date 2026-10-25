import type {
  CdpClient,
  CdpSessionTarget,
} from "../../../server/src/features/browser/cdp-client.js";

export interface OriginalSessionBrowser {
  cdp: CdpClient;
  target: CdpSessionTarget;
  pageErrors: unknown[];
  sessionCreateAcks: readonly unknown[];
  requests: readonly unknown[];
  evaluate<T = unknown>(expression: string): Promise<T>;
  close(): Promise<void>;
}

export function openOriginalSessionBrowser(options: {
  backendBaseUrl: string;
  backendOrigin: string;
  /** 仅供 Node 侧签发浏览器的一次性连接票据。 */
  accessToken: string;
  workspacePath: string;
  projectId: string;
  sessionId: string;
  clientId: string;
  newDraft?: boolean;
  workspaceShell?: boolean;
  fileManagerPreview?: boolean;
  restoreSession?: boolean;
  beforeNavigate?: (
    page: Pick<OriginalSessionBrowser, "cdp" | "target">,
  ) => Promise<void>;
  initialPreview?: {
    type?: "file" | "image";
    path: string;
    title: string;
    mediaType: string;
  };
}): Promise<OriginalSessionBrowser>;

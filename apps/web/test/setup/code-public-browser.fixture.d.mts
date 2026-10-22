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
  accessToken: string;
  workspacePath: string;
  projectId: string;
  sessionId: string;
  clientId: string;
  newDraft?: boolean;
  initialPreview?: {
    type?: "file" | "image";
    path: string;
    title: string;
    mediaType: string;
  };
}): Promise<OriginalSessionBrowser>;

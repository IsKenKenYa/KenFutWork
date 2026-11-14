import { z } from "zod";
import type { OriginalSessionBrowser } from "./code-public-browser.fixture.mjs";

export const viewerRpcSchema = z.object({
  service: z.enum(["file", "git", "file-watcher"]),
  method: z.string(),
  args: z.array(z.unknown()),
});
export type ViewerRequest = z.infer<typeof viewerRpcSchema> & {
  requestId: string;
  status?: number;
};

/** 只记录文件公开接口，不采集供应商或本机接入凭据。 */
export function observeViewerRequests(page: OriginalSessionBrowser) {
  const requests = new Map<string, ViewerRequest>();
  const releaseRequests = page.cdp.on(
    "Network.requestWillBeSent",
    (params, sessionId) => {
      if (sessionId !== page.target.sessionId) return;
      const request = z
        .object({ url: z.string(), postData: z.string().optional() })
        .parse(params.request);
      if (
        new URL(request.url).pathname !== "/api/code-ui/rpc" ||
        !request.postData
      )
        return;
      const payload = viewerRpcSchema.safeParse(JSON.parse(request.postData));
      if (!payload.success) return;
      const requestId = z.string().parse(params.requestId);
      requests.set(requestId, { requestId, ...payload.data });
    },
  );
  const releaseResponses = page.cdp.on(
    "Network.responseReceived",
    (params, sessionId) => {
      if (sessionId !== page.target.sessionId) return;
      const request = requests.get(z.string().parse(params.requestId));
      if (request)
        request.status = z
          .object({ status: z.number() })
          .parse(params.response).status;
    },
  );
  return {
    requests,
    dispose() {
      releaseRequests();
      releaseResponses();
    },
  };
}

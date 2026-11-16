import { appendFileSync, existsSync, unwatchFile, watchFile } from "node:fs";
import { createInterface } from "node:readline";

const uri = "ui://probe/card";
const invalidPage = new URL("invalid-mcp-page", import.meta.url);
const interactive = new URL("interactive-mcp-page", import.meta.url);
const calls = new URL("mcp-page-calls", import.meta.url);
const reads = new URL("mcp-page-resource-reads", import.meta.url);
const subscriptions = new URL("mcp-page-subscriptions", import.meta.url);
const resourceUri = "page://probe/items/approved?token=PRIVATE_RESOURCE_TOKEN";
const delayedUri = "page://probe/delayed?token=PRIVATE_RESOURCE_TOKEN";
const resourceTemplate = "page://probe/items/{item}";
const tool = {
  name: "show_card",
  description: "Show the page probe",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
};
const followupTools = [
  {
    name: "refresh_card",
    inputSchema: {
      type: "object",
      properties: { confirmation: { type: "string" } },
      required: ["confirmation"],
      additionalProperties: false,
    },
    _meta: { ui: { visibility: ["app"] } },
    annotations: { readOnlyHint: true },
  },
  {
    name: "model_only",
    inputSchema: { type: "object" },
    _meta: { ui: { visibility: ["model"] } },
  },
];
function page() {
  return `<h1>MCP App</h1><script>
    let input;
    let approved = false;
    let resourceCapability = false;
    let resourceReceived = false;
    let replayRejected = false;
    let toolsChanged = false;
    let resourcesChanged = false;
    let listUpdates = false;
    let inspectedCatalogs = false;
    let canSubscribe = false;
    let unexpectedUpdate = false;
    const send = (method, params, id) => parent.postMessage({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }, '*');
    const inspectCatalogs = () => {
      if (replayRejected && toolsChanged && resourcesChanged && !inspectedCatalogs) {
        inspectedCatalogs = true;
        if (canSubscribe) send('resources/subscribe', { uri: ${JSON.stringify(resourceUri)} }, 12);
      }
    };
    addEventListener('message', async ({ data, source }) => {
      if (source !== parent || data.jsonrpc !== '2.0') return;
      if (data.id === 1 && data.result?.protocolVersion) {
        resourceCapability = Boolean(data.result.hostCapabilities?.serverResources);
        listUpdates = data.result.hostCapabilities?.serverResources?.listChanged === true &&
          data.result.hostCapabilities?.serverTools?.listChanged === true;
        canSubscribe = Boolean(data.result.hostCapabilities?.experimental?.['zcode/resourceSubscribe']);
        send('ui/notifications/initialized', {});
      }
      if (data.method === 'notifications/resources/updated') {
        if (data.params?.uri !== ${JSON.stringify(resourceUri)} || data.params?._meta) unexpectedUpdate = true;
        else if (!unexpectedUpdate) send('tools/list', {}, 2);
      }
      if (listUpdates && !data.params?._meta?.hidden && data.method === 'notifications/resources/list_changed') {
        send('resources/list', {}, 10);
      }
      if (listUpdates && !data.params?._meta?.hidden && data.method === 'notifications/tools/list_changed') {
        send('tools/list', {}, 11);
      }
      if (data.id === 10 && data.result?.resources?.some(item => item.name === 'Updated page')) {
        resourcesChanged = true;
        inspectCatalogs();
      }
      if (data.id === 11 && data.result?.tools?.some(item => item.description === 'Updated tool')) {
        toolsChanged = true;
        inspectCatalogs();
      }
      if (data.id === 5 && data.result?.nextCursor === 'page-remainder') {
        send('resources/list', { cursor: data.result.nextCursor }, 6);
      }
      if (data.id === 6 && data.result?.resources?.some(item => item.uri === ${JSON.stringify(resourceUri)})) {
        send('resources/templates/list', {}, 7);
      }
      if (data.id === 7 && data.result?.resourceTemplates?.some(item => item.uriTemplate === ${JSON.stringify(resourceTemplate)})) {
        send('resources/read', { uri: '../relative-resource' }, 9);
      }
      if (data.id === 9 && data.error) {
        send('resources/read', { uri: ${JSON.stringify(resourceUri)} }, 8);
      }
      if (data.id === 8 && data.result?.contents?.[0]?.text === 'PRIVATE_RESOURCE_TEXT' &&
          data.result.contents[0]._meta?.process === ${process.pid} &&
          data.result.contents[1]?.blob === 'AAEC' && !resourceReceived) {
        resourceReceived = true;
        send('resources/read', { uri: ${JSON.stringify(resourceUri)} }, 8);
      }
      if (data.id === 8 && resourceReceived && data.error) {
        replayRejected = true;
        inspectCatalogs();
      }
      if (data.id === 2 && data.result?.tools?.some(tool => tool.name === 'refresh_card') &&
          !data.result.tools.some(tool => tool.name === 'model_only')) {
        send('tools/call', { name: 'model_only', arguments: {} }, 3);
      }
      if (data.id === 3 && (data.error || data.result?.isError)) {
        send('tools/call', { name: 'refresh_card', arguments: { confirmation: 'from_page' } }, 4);
      }
      if (data.id === 4) {
        const matches = data.result?.structuredContent?.process === ${process.pid};
        if (matches && !approved) {
          approved = true;
          send('tools/call', { name: 'refresh_card', arguments: { confirmation: 'from_page' } }, 4);
        } else {
          const replayDenied = approved && (data.error || data.result?.isError);
          send('ui/notifications/size-changed', { height: replayDenied ? 211 : 196 });
        }
      }
      if (data.method === 'ui/notifications/tool-input') input = data.params.arguments?.name;
      if (data.method === 'ui/notifications/tool-result') {
        let parentBlocked = false;
        try { void parent.document.body; } catch { parentBlocked = true; }
        const violation = new Promise(resolve => document.addEventListener('securitypolicyviolation', resolve, { once: true }));
        void fetch('http://127.0.0.1:1/exfil').catch(() => {});
        const networkBlocked = (await Promise.race([violation, new Promise(resolve => setTimeout(resolve, 300))]))?.effectiveDirective === 'connect-src';
        const matches = data.params._meta?.process === ${process.pid} &&
          data.params.structuredContent?.value === 'PRIVATE_VIEW' &&
          input === 'PAGE_INPUT' && parentBlocked && networkBlocked;
        send('ui/notifications/size-changed', { height: matches ? 173 : 111 });
        if (matches && resourceCapability && ${existsSync(interactive)}) send('resources/list', {}, 5);
      }
    });
    send('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'probe', version: '1' }, appCapabilities: {} }, 1);
  </script>`;
}

let supportsPage = false;
let catalogsChanged = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  let emitCatalogChanges = false;
  let emitResourceUpdate = false;
  if (method === "initialize") {
    supportsPage =
      params.capabilities.extensions?.[
        "io.modelcontextprotocol/ui"
      ]?.mimeTypes?.includes("text/html;profile=mcp-app") ?? false;
    result = {
      protocolVersion: params.protocolVersion,
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true, subscribe: true },
      },
      serverInfo: { name: "probe", version: "1" },
    };
  } else if (method === "tools/list") {
    result = {
      tools: [
        {
          ...tool,
          ...(supportsPage ? { _meta: { ui: { resourceUri: uri } } } : {}),
        },
        ...followupTools.map((item) =>
          catalogsChanged && item.name === "refresh_card"
            ? { ...item, description: "Updated tool" }
            : item,
        ),
      ],
    };
  } else if (method === "tools/call" && params.name === tool.name) {
    result = {
      content: [{ type: "text", text: "PUBLIC_RESULT" }],
      structuredContent: {
        value: existsSync(new URL("oversized-mcp-result", import.meta.url))
          ? "PRIVATE_VIEW".repeat(2_048)
          : "PRIVATE_VIEW",
      },
      _meta: { process: process.pid },
    };
  } else if (method === "tools/call") {
    appendFileSync(calls, `${params.name}:${params.arguments?.confirmation}\n`);
    result = { content: [], structuredContent: { process: process.pid } };
  } else if (method === "resources/list") {
    result =
      params?.cursor === "page-remainder"
        ? { resources: [{ name: "Task resource", uri: resourceUri }] }
        : {
            resources: [
              { name: catalogsChanged ? "Updated page" : "Page", uri },
            ],
            nextCursor: "page-remainder",
          };
  } else if (method === "resources/templates/list") {
    result = {
      resourceTemplates: [
        { name: "Task items", uriTemplate: resourceTemplate },
      ],
    };
  } else if (method === "resources/read" && params.uri === resourceUri) {
    appendFileSync(reads, "approved\n");
    if (!catalogsChanged) {
      catalogsChanged = true;
      emitCatalogChanges = true;
    }
    result = {
      contents: [
        {
          uri: resourceUri,
          text: "PRIVATE_RESOURCE_TEXT",
          _meta: { process: process.pid },
        },
        {
          uri: "page://probe/data",
          mimeType: "application/octet-stream",
          blob: "AAEC",
        },
      ],
    };
  } else if (method === "resources/read" && params.uri === uri) {
    result = {
      contents: [
        existsSync(invalidPage)
          ? { uri, mimeType: "text/plain", text: "PRIVATE_INVALID_PAGE" }
          : { uri, mimeType: "text/html;profile=mcp-app", text: page() },
      ],
    };
  } else if (method === "resources/read") {
    appendFileSync(reads, "unexpected\n");
  } else if (
    method === "resources/subscribe" ||
    method === "resources/unsubscribe"
  ) {
    const delayed = params.uri === delayedUri;
    const valid = params.uri === resourceUri || delayed;
    appendFileSync(
      subscriptions,
      `${valid ? method : "unexpected"}${delayed ? ":delayed" : ""}\n`,
    );
    if (delayed && method === "resources/subscribe") {
      const released = new URL("release-mcp-subscription", import.meta.url);
      await new Promise((resolve) => {
        const check = () => {
          if (!existsSync(released)) return;
          unwatchFile(released, check);
          resolve();
        };
        watchFile(released, { interval: 10 }, check);
        check();
      });
    }
    result = {};
    emitResourceUpdate = !delayed && valid && method === "resources/subscribe";
  }
  const response = result
    ? { result }
    : { error: { code: -32601, message: "Unknown method" } };
  process.stdout.write(
    `${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`,
  );
  if (emitCatalogChanges)
    for (const kind of ["resources", "tools"])
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: `notifications/${kind}/list_changed`,
          params: { _meta: { hidden: "PRIVATE_CATALOG_SIGNAL" } },
        })}\n`,
      );
  if (emitResourceUpdate)
    for (const target of ["page://probe/unsubscribed", resourceUri])
      process.stdout.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          method: "notifications/resources/updated",
          params: { uri: target, _meta: { private: "NOTIFICATION_PRIVATE" } },
        })}\n`,
      );
}

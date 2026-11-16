import { createInterface } from "node:readline";

const uri = "ui://probe/card";
const tool = {
  name: "show_card",
  description: "Show the page probe",
  inputSchema: { type: "object", properties: { name: { type: "string" } } },
};
function page() {
  return `<h1>MCP App</h1><script>
    let input;
    const send = (method, params, id) => parent.postMessage({ jsonrpc: '2.0', method, params, ...(id === undefined ? {} : { id }) }, '*');
    addEventListener('message', async ({ data, source }) => {
      if (source !== parent || data.jsonrpc !== '2.0') return;
      if (data.id === 1 && data.result?.protocolVersion) send('ui/notifications/initialized', {});
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
      }
    });
    send('ui/initialize', { protocolVersion: '2026-01-26', appInfo: { name: 'probe', version: '1' }, appCapabilities: {} }, 1);
  </script>`;
}

let supportsPage = false;
for await (const line of createInterface({ input: process.stdin })) {
  const { id, method, params } = JSON.parse(line);
  if (id === undefined) continue;
  let result;
  if (method === "initialize") {
    supportsPage = params.capabilities.extensions?.["io.modelcontextprotocol/ui"]
      ?.mimeTypes?.includes("text/html;profile=mcp-app") ?? false;
    result = { protocolVersion: params.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "probe", version: "1" } };
  } else if (method === "tools/list") {
    result = { tools: [{ ...tool, ...(supportsPage ? { _meta: { ui: { resourceUri: uri } } } : {}) }] };
  } else if (method === "tools/call" && params.name === tool.name) {
    result = {
      content: [{ type: "text", text: "PUBLIC_RESULT" }],
      structuredContent: { value: "PRIVATE_VIEW" },
      _meta: { process: process.pid },
    };
  } else if (method === "resources/read" && params.uri === uri) {
    result = { contents: [{ uri, mimeType: "text/html;profile=mcp-app", text: page() }] };
  }
  const response = result ? { result } : { error: { code: -32601, message: "Unknown method" } };
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...response })}\n`);
}

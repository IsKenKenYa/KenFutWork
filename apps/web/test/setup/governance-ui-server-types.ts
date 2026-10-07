import type { InstanceSettings } from "@kenfutwork/shared";
import type { AgentGovernanceSettings } from "../../src/lib/agent-governance-settings.js";

export type Values = AgentGovernanceSettings;
export type Method = "GET" | "PATCH";
export type GateState = "armed" | "captured" | "delivered" | "dropped";
export type GateSummary = {
  id: string;
  requestId?: string;
  method: Method;
  state: GateState;
  status?: number;
  phase: "request" | "response";
  requestSent: boolean;
};
export type RequestSummary = {
  id: string;
  method: string;
  path: string;
  status?: number;
  patch?: Record<string, number | boolean>;
  patchKeys?: string[];
};
export type Inspection = {
  instanceId: string;
  values: Values;
  indexValues: { enabled: boolean; autoNewFolder: boolean };
  collections: Pick<InstanceSettings, "commands" | "hooks">;
  stored: Partial<Record<keyof Values, number | boolean | null>>;
  gates: GateSummary[];
  requests: RequestSummary[];
};
export type Command = { requestId: number } & (
  | {
      operation: "gate";
      id: string;
      method: Method;
      hold?: boolean;
      phase?: "request" | "response";
      match?: { key: string; value: number | boolean };
    }
  | { operation: "release"; id: string }
  | { operation: "drop"; id: string }
  | { operation: "inspect" }
  | { operation: "stop" }
);
export type Reply =
  | { type: "ready"; baseUrl: string; instanceId: string; dataDir: string }
  | { type: "reply"; requestId: number; ok: true; value?: Inspection }
  | { type: "reply"; requestId: number; ok: false; error: string }
  | { type: "failed"; error: string };

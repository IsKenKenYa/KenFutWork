import type { ApprovalIdentity } from "../permissions/approval-types.js";

/** 宿主拥有的管理文件引用；从实例数据根解析，不能作为Task目录授权。 */
export interface CodePlanRef {
  planId: string;
  relativePath: string;
  sha256: string;
}

export interface CodeApprovedPlan extends ApprovalIdentity {
  planRef: CodePlanRef;
  approvedAt: number;
}

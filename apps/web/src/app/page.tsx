import { redirect } from "next/navigation";

/** 无落地页：根路径直接进入工作台（本地接入状态由实例上下文校验）。 */
export default function RootPage() {
  redirect("/workbench");
}

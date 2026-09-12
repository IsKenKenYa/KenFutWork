import { redirect } from "next/navigation";

/** 无落地页：根路径直接进入工作台（未登录由 /workbench 守卫跳 /login）。 */
export default function RootPage() {
  redirect("/workbench");
}

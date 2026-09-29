import { isDesktopRuntime } from "../../desktop/runtime.js";
import { registerSystemRoutes } from "../../http/system.js";
import type { PluginDefinition } from "../../kernel/types.js";
import { createNativeDirectoryPicker } from "./directory-picker.js";

/**
 * system 插件（FORM-2 桌面形态的宿主能力）：把「系统文件夹对话框」暴露成一个端点。
 *
 * 为什么放在服务端：浏览器只给得到目录名（`FileSystemDirectoryHandle` 传不给服务端），
 * 只有服务端才知道本机绝对路径。桌面形态下服务端与用户同机，弹一次系统对话框拿回绝对
 * 路径，是唯一能让「打开文件夹」真正接通的路子；其它形态如实报不可用，客户端回落
 * 「填本机路径」。
 *
 * 不注册 ctx key：这条能力只有 HTTP 路由一个消费方（agent 侧用不到），按「能力缝三元组」
 * 的口径它不需要 service definition——真出现第二个消费方时再抽。
 */
export function createSystemPlugin(): PluginDefinition {
  return {
    name: "system",
    inject: ["auth"],
    apply() {
      // 无服务可注册：本插件的全部作用面是 mounted 里的路由。
    },
    mounted(ctx) {
      const desktop = isDesktopRuntime(ctx.env);
      void registerSystemRoutes(ctx.app, {
        auth: ctx.get("auth"),
        picker: createNativeDirectoryPicker(),
        desktop: desktop
          ? true
          : {
              available: false,
              // 只说事实。别再指路「填本机路径」——那个入口已按用户口径从界面移除，
              // 提它等于让人去找一个不存在的东西。
              reason: "非桌面形态：系统文件夹对话框开不到你面前",
            },
      });
    },
  };
}

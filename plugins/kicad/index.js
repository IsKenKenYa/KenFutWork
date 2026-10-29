/**
 * KiCad 电路插件。
 *
 * 装上后 Work 引擎出现「电路」一档。KiCad 是**用户自己装在机器上**的桌面软件：
 * 我们不下载、不内嵌、不代理它的界面，只在用户点「打开」时唤起本机那个进程
 * （见服务端 `features/work/native-app.ts` 的安装探测与 `/launch`）。
 *
 * 为什么不做内嵌：KiCad 是 Qt 原生应用，浏览器里跑不起来；把它包成 wasm 是重写，
 * 不是集成。如实做成「唤起本机应用」，没装就明确告诉用户去装，比摆一个假画布诚实。
 */

export const name = "kenfutwork-kicad";

export const inject = [];

export function apply() {
  // 唤起与安装探测由 Work 宿主提供，插件本体只持有市场条目与市场图标。
}

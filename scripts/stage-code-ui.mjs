import { cp, mkdir, rm } from "node:fs/promises";
import { resolve } from "node:path";

// Vite 独立文档输出由 Next 静态产物承载，不进入 Design 的 CSS/React 树。
const root = resolve(import.meta.dirname, "..");
const source = resolve(root, "apps/web/src/components/workbench/zcode/dist");
const target = resolve(root, "apps/web/public/code-ui");
await mkdir(resolve(root, "apps/web/public"), { recursive: true });
await rm(target, { recursive: true, force: true });
await cp(source, target, { recursive: true });
process.stdout.write("已准备 Code 独立客户端静态产物。\n");

"use client";

import { BrandKitPage } from "../../components/brand-kit/brand-kit-page";

/**
 * 品牌套件管理页（`/brand-kit`）。
 *
 * 为什么需要这个路由：`components/brand-kit/` 里那套管理 UI（列表/新建/编辑器/
 * 配色/字体/Logo/素材）本来是**完整实现但没有任何路由或引用**——画布上的「品牌套件」
 * 只能在下拉里选，选不到也建不出（选择器永远显示「暂无品牌套件」）。这里把它接到
 * 路由上，并由选择器下拉的「管理品牌套件…」入口进入。
 */
export default function BrandKitRoutePage() {
  return <BrandKitPage />;
}

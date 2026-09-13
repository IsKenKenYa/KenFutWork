# KenFutWork 品牌 Logo 规范

> 定稿于 2026-09-13。本文是品牌 logo 的唯一权威说明；SVG 源文件与本文件同目录。

## 定稿方案：KF-2 骨架版 C（岚配色）

对角线把图标分成两半，同一个靛蓝色相只靠深浅区分——左上浅色代表 Design 画布，右下深色代表 Code 终端。白色字形严格对应用户红笔手绘骨架的四笔，上臂加长伸出顶横：

- **顶横 + 竖笔**：F 的起笔（顶横贴图标顶部 y64，右端至 x352）；
- **上臂**：从 (372,176) 斜插到竖笔中部交点 (180,252)，**尾端越过顶横右端再往右伸出一段**（臂尖至 x385），冲劲更足；
- **下腿**：从交点向右下 (346,359)。
- F = 顶横 + 竖笔；K = 竖笔 + 上臂 + 下腿。

## 几何与色值

画布 `viewBox="0 0 512 512"`，纯手写 SVG（无设计工具依赖，浏览器可直接渲染预览）：

| 元素 | 参数 |
| --- | --- |
| 底形 | 超椭圆（小米式方圆角）：`|x/256|⁵ + |y/256|⁵ = 1`，n=5、中心 (256,256)，path 内嵌于 `clipPath`（参数方程采样生成，见定稿文件） |
| 左上半（Design 画布） | 135° 渐变 `#575E96 → #686FA9` |
| 右下半（Code 终端） | 135° 渐变 `#3C4272 → #494F84`，分界对角线为 (512,0)→(0,512) |
| 竖笔 | `rect x=144 y=64 w=72 h=320 rx=8`（y64-384） |
| 顶横（F 起笔） | `rect x=144 y=64 w=208 h=72`（右端 x352） |
| 上臂（K，加长伸出） | `path M372 176 L180 252`，臂尖 (372,176) 越过顶横右端，`stroke-width=72` |
| 下腿（K） | `path M180 252 L346 359`，`stroke-width=72` |

调整流程：先改 `定稿-kf2-岚.svg`，再同步 `logo.svg` / `favicon.svg` 两个落地副本（内容一致，直接复制）；`apple-touch-icon.png` 按下表重新生成。

## 应用位置

| 位置 | 资源 | 说明 |
| --- | --- | --- |
| 浏览器标签页图标 | `apps/web/public/favicon.svg` | `layout.tsx` metadata `icons.icon` |
| Apple 触屏图标 | `apps/web/public/apple-touch-icon.png` | 180×180 方角全出血（iOS 自动裁圆角），由定稿 SVG 去掉圆角底（`rx=0` 直角矩形填充）后用无头 Chrome 截图生成 |
| metadata apple 图标 | `apps/web/public/logo.svg` | `layout.tsx` metadata `icons.apple` |
| 加载页 | `apps/web/src/components/loading-screen.tsx` | 以 `<img src="/logo.svg">` 引用，浮动动画保留 |

Code / Design 双模式的界面承载（侧栏分段开关）与 logo 的对角双色隐喻对应，**界面不随 logo 调整改动**。

## 边界与历史

- `apps/web/src/components/icons/loomic-logo.tsx` 是 **Loomic 画布的自有品牌**（Design 模式依赖物），不随本次更换，保持旧黑色 K 样式。
- `apps/web/public/og-image.png`（社交分享卡 1200×630）仍为旧视觉，尚未重做；需要时基于本规范重新生成。
- 本目录其余文件为设计过程存档：`preview.html`（三概念提案 A/B/C）、`preview-c-colors.html`（方案 C 配色变体 V1–V4）、`preview-kf.html`（K+F 融合提案与上臂调整，终稿为 KF-2 骨架版 C）、`concept-*.svg`（各提案源文件）。定稿为方案 C 的 V4「岚」配色 + KF-2 骨架版 C 字形（上臂加长伸出），底形为小米式超椭圆。

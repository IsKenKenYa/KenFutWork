# KenFutWork 品牌 Logo 规范

> 定稿于 2026-09-13；2026-09-15 白字形换成 Chakra Petch Italic 笔画（底形与配色不变）。
> 本文是品牌 logo 的唯一权威说明；SVG 源文件与本文件同目录。

## 定稿方案：KF-2 骨架版 C（岚配色，白字形为 Chakra Petch Italic）

对角线把图标分成两半，同一个靛蓝色相只靠深浅区分——左上浅色代表 Design 画布，右下深色代表 Code 终端。

白色字形沿用用户红笔手绘骨架的**结构**：**竖笔 + 顶横（F）+ 上臂 + 下腿（K），F 与 K 共用同一根竖笔**；
笔画则取自 **Chakra Petch Italic**（SIL OFL）——竖笔／上臂／下腿是该字体 `K` 的完整轮廓，顶横是该字体
`F` 裁掉顶横以下、并把右端裁到定稿比例后剩下的那段，两者以布尔并集焊成一根笔画。
上臂尖露在顶横右端之外（沿用旧骨架「上臂加长伸出」的规矩）；裁短顶横正是为了让这道缝留出来，
否则真字体的 K 上臂顶到 cap 高，会和顶横围出封闭碗形、整个标读成 R。生成过程见 `方案对比.html`。

## 几何与色值

画布 `viewBox="0 0 512 512"`，纯手写 SVG（无设计工具依赖，浏览器可直接渲染预览）：

| 元素 | 参数 |
| --- | --- |
| 底形 | 超椭圆（小米式方圆角）：`|x/256|⁵ + |y/256|⁵ = 1`，n=5、中心 (256,256)，path 内嵌于 `clipPath`（参数方程采样生成，见定稿文件） |
| 左上半（Design 画布） | 135° 渐变 `#444B7E → #575E96` |
| 右下半（Code 终端） | 135° 渐变 `#2F3459 → #3C4272`，分界对角线为 (512,0)→(0,512) |
| 白字形 | 单条 `<path fill="#FFFFFF">`（Chakra Petch Italic 的 K 轮廓 + 裁短后的 F 顶横，布尔并集后烘焙到 512 画布坐标） |
| 字形外框 | 高 312、宽 306，水平居中 (x 103→409)、垂直中心 y=246 |

调整流程：白字形**不能手改**——它是字体轮廓的布尔并集结果，要改先改 `方案对比.html` 的生成参数
（目标字体、字面高、画布位置）再重出，然后按顺序同步：`最终定稿.svg` → `apps/web/public/logo.svg`
→ `apps/web/public/favicon.svg` → `apps/web/src/components/icons/kenfutwork-logo.tsx` → `apple-touch-icon.png`
→ `og-image.png`。前四个是同一份 SVG 内容（直接复制），后两个是位图，按下面的说明重出。

## 应用位置

| 位置 | 资源 | 说明 |
| --- | --- | --- |
| 浏览器标签页图标 | `apps/web/public/favicon.svg` | `layout.tsx` metadata `icons.icon` |
| Apple 触屏图标 | `apps/web/public/apple-touch-icon.png` | 180×180 方角全出血（iOS 自动裁圆角）：把定稿的圆角 `clipPath` 换成整块矩形（对角双色铺满），无头 Chrome 截 180×180 |
| metadata apple 图标 | `apps/web/public/logo.svg` | `layout.tsx` metadata `icons.apple` |
| 加载页 | `apps/web/src/components/loading-screen.tsx` | 以 `<img src="/logo.svg">` 引用，浮动动画保留 |
| React 组件 | `apps/web/src/components/icons/kenfutwork-logo.tsx` | 定稿的 React 落地（侧栏收起/展开、登录页 `auth-shell.tsx`） |
| 社交分享卡 | `apps/web/public/og-image.png` | 1200×630，深蓝渐变底 + 标 + 字标 + 「插件化 BYOK Agent 工作台」+ Code/Design/自管 Postgres 三个胶囊 |

Code / Design 双模式的界面承载（侧栏分段开关）与 logo 的对角双色隐喻对应，**界面不随 logo 调整改动**。

## 候选字体（logo 字形 / 字标）

2026-09-15 用户从字体天下（fonts.net.cn）挑了四款字体，用于改 logo 字形。图标是纯几何图形、没有文字，
「KenFutWork」字样（字标）目前是系统无衬线、无自有字体。两个落点各有一份对照页：

| 落点 | 对照页 | 现状 |
| --- | --- | --- |
| **logo 图标字形**（**已换**） | `方案对比.html` | Chakra Petch Italic 笔画，结构同旧骨架（共竖笔） |
| 字标文字（旁边那行字） | `字体风格对比.html` | `text-base`/`text-lg` + `font-semibold tracking-tight` |

两页都要把字体放进本目录 `字体/`（已 gitignore）才能渲染，重装方法见文末。

### 授权（用户最初的四款候选：均非商免）

**用户最初挑的四款全部是字体天下的「非商免」字体**——详情页原文：*「若您要将该字体用于商业用途，须在使用前
取得书面授权，该授权可能需要您支付相应的版权费用。」* 产品 logo 属商用，因此这四款都不能在取得书面授权前随包分发；
其中 Romance Frances 连下载都需先购买（下载接口返回 `FontDownloadPurchaseRequired`）。
**最终采用的 Chakra Petch Italic 是 SIL OFL 授权，可商用、无此限制**——详见下面「授权（采用款）」。

| 候选 | 出品方 | 风格 | 授权 | 本机样张 |
| --- | --- | --- | --- | --- |
| Sounso Quality | 上首造字 | 科技：方形圆角碗 + 斜体，与超椭圆底同源 | 非商免 | 有 |
| Romance Frances | 字语字库 | 粗笔刷连体手写，带装饰大提笔 | 付费授权 | 无（用 Pacifico 代渲染） |
| YEFONTPaws-Bold | 也字工厂 | 卡通漫画：蜡笔／马克笔手绘全大写 | 非商免 | 有 |
| ArtierEN | 字语字库 | 手写：硬角粗笔刷、斜切收笔 | 非商免 | 有 |

要零授权风险直接下发，用同风格的 OFL（SIL Open Font License，可商用）替代：

| 风格方向 | OFL 替代 | 来源 |
| --- | --- | --- |
| 科技（对应 Sounso Quality） | Chakra Petch Italic / K2D Italic | Google Fonts |
| 手写笔刷（对应 Romance Frances） | Pacifico | Google Fonts |
| 手绘（对应 YEFONTPaws-Bold） | Permanent Marker / Gochi Hand | Google Fonts |
| 硬角笔刷（对应 ArtierEN） | Caveat Brush | Google Fonts |

### logo 字形：笔画共用（现版结构 + 字体笔画）

定稿的结构是 **竖笔 + 顶横（F）+ 上臂 + 下腿（K），F 与 K 共用同一根竖笔**。改字体风格时结构不动，
只换成「用该字体的笔画去画这四笔」：

- **竖笔 / 上臂 / 下腿** ← 该字体 `K` 的完整轮廓（K 本身就是竖笔 + 两斜笔）；
- **顶横** ← 该字体 `F` 在顶横下方裁掉后剩下的那段，再把右端裁到定稿比例（总长 ≈ 2.9 × 竖笔宽）；
- 两者用 **skia-pathops 布尔并集**合成一根笔画，不是叠放（叠放会出双线，就是「直接用字形」的问题）。

**为什么顶横要裁短**：定稿的上臂起笔故意压得低（y176，在顶横 y136 之下），所以顶横和上臂之间留缝、读成
「K + 顶横」。真字体的 K 上臂是顶到 cap 高的，顶横不裁就会和上臂围出一个封闭的碗形，整个标读成 **R**。
实测 Chakra Petch 不裁就是清清楚楚一个 R，裁到定稿比例后回到「K + 顶横」。

**六款实测**：

| 字体 | 读感 |
| --- | --- |
| Sounso Quality | 稳定读成「K + 顶横」，168→16px 全程可辨，与超椭圆底同源 |
| **Chakra Petch Italic（OFL）** | **采用款**。同上，方切角更规整 |
| K2D Italic（OFL） | 同上，圆角碗更柔 |
| Romance Frances（以 Pacifico 代） | 读成花体 K，顶横被卷进 K 的起笔装饰，F 不可辨 |
| YEFONTPaws-Bold | 蜡笔笔触粗细不匀，顶横与上臂糊成一块，读成 R，结构不成立 |
| ArtierEN | K 的上臂起点高，顶横裁短后仍围成封闭碗形，读成 R，结构不成立 |

结论：**「共用竖笔」这个结构只在几何／直线骨架的字体上成立**——它依赖顶横与上臂之间那道缝。
笔刷与蜡笔类字体的笔画本身带弧、带连带、粗细不匀，缝要么被填掉要么被卷走，F 就丢了。
所以能走这条路的只有科技一路（Sounso Quality，或其 OFL 对应 Chakra Petch / K2D）。

### 重装本机样张

`字体/` 目录不入库，需要时按对照页 `<style>` 里的文件名重新放回：

- 三个非商免样张：字体天下对应详情页 → 本地下载
  （`Sounso Quality` / `font-40377173299`、`ArtierEN` / `font-45246149793`、`YEFONTPaws-Bold` / `font-45536175656`）；
- OFL 替代：`https://fonts.googleapis.com/css2?family=<Family>:<axis>&display=swap` 返回的 CSS 里取 `/* latin */` 块的 woff2
  （注意别取到 latin-ext / thai 子集，否则浏览器会回退）。

重出渲染快照：`python -m http.server` 起本地服务 + 
`chrome --headless=new --window-size=1440,6000 --screenshot=… <页面>`（**必须走 http，`file://` 下 Chrome 不加载 webfont**）。

### 授权（采用款）

采用款 **Chakra Petch Italic** 来自 Google Fonts，授权为 **SIL Open Font License 1.1（OFL）**：允许商用、
允许嵌入与再分发，只要求不得单独售卖字体本身、不得使用其保留字体名（Chakra Petch 无 RFN）。
本仓库把字形转成轮廓路径烘焙进 SVG，**不随包分发字体文件**，因此无附加义务；
出处记录在此即可（Google Fonts / Cadson Demak 设计）。

### 已定（2026-09-15）

用户选定 **Chakra Petch Italic**，已落地：权威源 `最终定稿.svg` 与 `logo.svg`／`favicon.svg`／
`kenfutwork-logo.tsx`／`apple-touch-icon.png`／`og-image.png` 全部换新。对照页只保留三款合格变体
（Chakra Petch Italic 采用版、Sounso Quality、K2D Italic）；YEFONTPaws-Bold、ArtierEN、Romance Frances
三款因结构不成立已从页面移除。

**字标（旁边那行字）仍是系统无衬线，本次未动。** 若以后要换，落点是
`apps/web/src/components/workbench/workbench.tsx`（侧栏）与 `apps/web/src/components/auth/auth-shell.tsx`
（登录页）的字重/字距，字体文件放 `apps/web/public/fonts/`。

## 边界与历史

- 2026-09-15 之前，白字形是**等宽直线骨架四笔**（`rect` + `stroke-width=72` 的斜线）；本轮换成 Chakra Petch Italic 的字体笔画，
  结构未变。旧字形存档在 `方案对比.html` 的「旧定稿（历史对照，已替换）」一块里。
- **字标（「KenFutWork」那行字）仍是系统无衬线**，未随本次更换。用户在 2026-09-15 明确「改的是 logo，不是旁边的字」。
- `apps/web/src/components/icons/kenfutwork-logo.tsx` 就是本定稿的 React 落地（沿用旧文件名），不是另一套品牌；
  工作台侧栏（收起/展开）、登录页 `auth-shell.tsx` 都用它。
- `apps/web/public/og-image.png` 已在 2026-09-15 随新标重出（1200×630：深蓝渐变底 + 标 + 字标 + 「插件化 BYOK Agent 工作台」+ Code/Design/自管 Postgres 三个胶囊）。
- **本目录只留定稿与说明（2026-09-16 清理）**，共四个文件：本文件（说明）、`最终定稿.svg`（唯一权威源）、
  `方案对比.html`（字形生成工具——改白字形先改这里的参数再重出）、`字体风格对比.html`（字标候选，未采用，留作后续决策）。
  同日又改名：`定稿-kf2-岚.svg` → `最终定稿.svg`，`preview-logo字形.html` → `方案对比.html`，
  `preview-字标字体.html` → `字体风格对比.html`；两张渲染快照（`logo字形对照.png`／`字标字体对照.png`）已删除，要重出照上文命令走。
  更早的三概念提案 A/B/C、方案 C 配色变体 V1–V4、K+F 融合提案的对照页与 `concept-*.svg` 源文件亦已删除，
  需要时从 git 历史取回（`git checkout <删除提交>^ -- docs/design/logo`）。

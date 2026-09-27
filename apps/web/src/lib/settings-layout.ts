/**
 * 设置弹窗的统一版式（**唯一出处**）。
 *
 * 背景：2026-09-27 用户连续四轮就设置页反馈「很啰嗦 / 排版不合理 / 排版很乱」，最后一轮
 * 把弹窗逐页量了一遍，量出来的是**没有规范**：
 * - 页面标题有四种规格：`text-base/500`、`text-lg/600`、`text-lg/500`、`text-sm/500`；
 *   同一个「通用」页里「外观」是 16px 而「模型」「个人资料」是 18px；语音 / 关于 / 插件面板
 *   三页根本没有标题。
 * - 块与块的间距有八个值：4 / 8 / 12 / 13 / 16 / 20 / 24 / 32（`mb-*`、`mt-*`、`space-y-*`
 *   各写各的）。
 * - 全宽行（`SETTINGS_ROW`）在两个文件里各抄了一份。
 *
 * 于是把版式收成四个常量：一个页面 = 若干分区（`SETTINGS_SECTION_GAP` 相隔），
 * 每个分区 = 标题（`SETTINGS_TITLE`，标题与内容 8px）+ 内容；设置里的行统一用 `SETTINGS_ROW`。
 * 新增设置页只引这几个常量，不要再写一遍 className 字面量。
 */

/**
 * 页面 / 分区标题的**字号字重**（16px/500），不含外边距。
 * 标题与徽标同排时（如「使用统计」+「应用用量」）用这个：给标题自己挂 `mb-2` 会在
 * flex 行里把它顶偏（实测标题比同排徽标高 4px），间距该挂在那一行上。
 */
export const SETTINGS_TITLE_TEXT = "text-base font-medium";

/** 页面 / 分区标题：16px/500，标题与它自己的内容相隔 8px。 */
export const SETTINGS_TITLE = `${SETTINGS_TITLE_TEXT} mb-2`;

/** 分区之间：24px。 */
export const SETTINGS_SECTION_GAP = "space-y-6";

/** 分区内的行之间：8px。 */
export const SETTINGS_ROW_STACK = "space-y-2";

/**
 * 设置里一行的**最小高度**（2.625rem = 42px），单独导出给「行自带边框」用不了的行：
 * `divide-y` 列表里的行共用一条分割线，各自再画 `border` 就会双线——那种行只借这个高度。
 */
export const SETTINGS_ROW_MIN_HEIGHT = "min-h-[2.625rem]";

/**
 * 设置里的一行：全宽、`min-h` 2.625rem（42px）、标签左值右。
 *
 * `min-h` 不是凑数：同一列表里有的行带尾控件（下载/删除按钮）有的不带，不兜底就是
 * 38px 与 42px 交替（真机量过）。兜在行上，不靠往每行插空占位元素。
 * 高度还必须**跨页一致**：曾经用这个常量的页是 42px、手写的是 38px，翻页就能看出差别。
 */
export const SETTINGS_ROW = `flex w-full ${SETTINGS_ROW_MIN_HEIGHT} items-center gap-2 rounded-lg border px-3 py-2 text-sm`;

# Work 编辑器内置字体

随产品分发的开源字体（Work 引擎页「字体」区展示，编辑器按 `fonts/manifest.txt` 取用）。
**只放许可允许随软件再分发的字体**；每个字体同目录带许可全文，列表名后面标注出品方或许可类型。

| 字体（列表显示名） | 文件 | 出品方 | 许可 | 来源 |
| --- | --- | --- | --- | --- |
| Inter | `Inter-Regular.ttf`、`Inter-Bold.ttf` | Rasmus Andersson | SIL OFL 1.1（`OFL-Inter.txt`） | https://github.com/rsms/inter |
| Liberation Serif | `LiberationSerif-Regular.ttf`、`-Bold.ttf` | Red Hat / Liberation Fonts | SIL OFL 1.1（`OFL-Liberation-Serif.txt`） | https://github.com/liberationfonts/liberation-fonts |
| JetBrains Mono | `JetBrainsMono-Variable.ttf` | JetBrains | SIL OFL 1.1（`OFL-JetBrains-Mono.txt`） | https://github.com/JetBrains/JetBrainsMono |
| 霞鹜文楷（开源） | `LXGWWenKaiLite-Regular.ttf` | lxgw（落霞孤鹜） | SIL OFL 1.1（`OFL-LXGW-WenKai-Lite.txt`） | https://github.com/lxgw/LxgwWenKai-Lite |
| 霞鹜漫黑（开源） | `LXGWMarkerGothic-Regular.ttf` | lxgw（落霞孤鹜） | SIL OFL 1.1（`OFL-LXGW-Marker-Gothic.txt`） | https://github.com/lxgw/LxgwMarkerGothic |
| 思源黑体（开源） | `NotoSansCJKsc-Regular.otf` | Adobe × Google（Source Han Sans / Noto Sans CJK） | SIL OFL 1.1（`OFL-Noto-CJK.txt`） | https://github.com/notofonts/noto-cjk |
| 思源宋体（开源） | `NotoSerifCJKsc-Regular.otf` | Adobe × Google（Source Han Serif / Noto Serif CJK） | SIL OFL 1.1（`OFL-Noto-CJK.txt`） | https://github.com/notofonts/noto-cjk |
| 得意黑（开源） | `SmileySans-Oblique.ttf` | oooooohmygosh / Atelier Anchor | SIL OFL 1.1（`OFL-Smiley-Sans.txt`，含 Reserved Font Name） | https://github.com/atelier-anchor/smiley-sans |
| 悠哉字体（开源） | `Yozai-Regular.ttf` | lxgw（落霞孤鹜）/ Y.Oz | SIL OFL 1.1（`OFL-Yozai.txt`） | https://github.com/lxgw/yozai-font |
| 朱雀仿宋（开源） | `ZhuqueFangsong-Regular.ttf` | 璇玑造字 TrionesType | SIL OFL 1.1（`OFL-Zhuque-Fangsong.txt`） | https://github.com/TrionesType/zhuque |
| 马善政毛笔楷书（开源） | `MaShanZheng-Regular.ttf` | Google Fonts（Ma Shan Zheng） | SIL OFL 1.1（`OFL-Ma-Shan-Zheng.txt`） | https://github.com/google/fonts/tree/main/ofl/mashanzheng |
| 站酷快乐体（站酷） | `ZCOOLKuaiLe-Regular.ttf` | 站酷 ZCOOL（Google Fonts 分发版） | SIL OFL 1.1（`OFL-ZCOOL-KuaiLe.txt`） | https://github.com/google/fonts/tree/main/ofl/zcoolkuaile |
| 抖音美好体（开源） | `DouyinSans-Bold.ttf` | 字节跳动 ByteDance | SIL OFL 1.1（`OFL-Douyin-Sans.txt`） | https://github.com/bytedance/fonts |
| 更纱黑体（开源） | `SarasaGothicSC-Regular.ttf` | Belleve Invis（atelierAnchor） | SIL OFL 1.1（`OFL-Sarasa-Gothic.txt`） | https://github.com/be5invis/Sarasa-Gothic |

## 不内置的免费商用字体

这些字体可以免费商用、也允许嵌入，但授权是**专有、不可转让**的，随 GPL 产物再分发会让下游拿不到授权——
用户可以在「字体 → 上传」里放入自己从官方页下载的文件，只在本机实例使用：

- **MiSans**（小米）：可在软件中嵌入并要求注明「使用了 MiSans」；不可转让、可撤销。
- **HarmonyOS Sans**（华为）：同样允许嵌入/捆绑并要求在软件中注明；不可转让、可撤销。
- **vivo Sans / OPPO Sans / HONOR Sans**：免费商用，但明确禁止再分发字体副本。
- **阿里巴巴普惠体**：各版本条款不一致（2.0 禁止转载字体文件，3.0 删去该条），暂不入库。
- 方正四大免费字体（黑体/书宋/仿宋/楷体）：仅「商业发布」免费，嵌入产品仍需授权。

## 约束

- 只收 SIL OFL 1.1 许可的字体；改名、改写字形都不做，保留 Reserved Font Name。
- 新增字体：放 ttf/otf + 许可全文到本目录，登记 `apps/server/src/features/work/fonts.ts` 的
  `BUNDLED_LICENSES` / `BUNDLED_CJK`，并在根 `THIRD-PARTY-NOTICES.md` 登记来源与许可。

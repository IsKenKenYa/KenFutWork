-- 系统技能的 description 是技能卡片上给用户看的那行文案，与 skills/<slug>/SKILL.md 的
-- frontmatter 同源：文件已改中文（做海报/做图两条），这里把既有安装的注册表同步过来。
-- skill_content 仍为空（内容从文件系统加载），只改 description。
update public.skills
set description = '做海报、视觉稿、静态设计图 · 用代码生成 .png / .pdf（需 execute 与 Python Pillow / reportlab）'
where slug = 'canvas-design';

update public.skills
set description = '生成图片时用结构化 JSON 提示词（更稳、更可控）· 配合 generate_image 工具'
where slug = 'json-image-prompt';

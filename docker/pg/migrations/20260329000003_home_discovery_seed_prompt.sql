-- Add Loomic-internal prompt payloads for home discovery cards.
-- Discovery cards no longer navigate to external case URLs in the UI.

alter table public.home_discovery_cases
  add column seed_prompt text not null default '';

update public.home_discovery_cases
set seed_prompt = case id
  when 'ji5ey5l' then '请基于 ART & Cultural Arts Center 这个灵感方向，为我做一套文化艺术中心品牌探索。输出品牌关键词、主视觉方向、海报延展和社交媒体视觉提案，整体气质要现代、文化感强、适合艺术活动传播。'
  when 'n9d21de' then '围绕 Vintage Car Poster 这个方向，帮我设计一组复古汽车主题海报。需要包含主海报、社交媒体方图版本和标题排版建议，整体风格偏复古、胶片感、适合活动宣传。'
  when 'bjde0nh' then '参考 Cat Tarot Cards 这个主题，帮我扩展一套猫咪塔罗风格插画系列。请给出角色设定、牌面视觉语言、配色建议和可延展的周边方向。'
  when 'tl8zzk0' then '以 Fallout-themed cake shop website 为灵感，帮我设计一个末日废土风蛋糕店官网。输出首页信息架构、首屏视觉、商品卡片样式和核心配色建议。'
  when 'fbn3mss' then '请围绕 My Creepy Clown Avatar in Abandoned Circus Park 这个概念，帮我做一套诡异马戏团角色设计。包含角色设定、表情变化、服装元素和场景氛围建议。'
  when 'ikqo02k' then '基于 Mixtapes Emotions 这个方向，帮我做一组音乐情绪短片分镜。需要拆出镜头节奏、情绪转场、标题卡和视觉风格建议，适合做 15 到 30 秒的短视频。'
  when 'a4ncmvb' then '围绕 Product Visualization - Robot Hand 这个概念，帮我设计一组未来感机械手产品视觉。请给出产品卖点表达、主视觉构图、材质方向和电商展示图思路。'
  when 'ng716s0' then '请以 Building a new website and learning how to AI 为起点，帮我设计一个面向建筑工作室的网站概念。输出网站结构、首页视觉、项目展示模块和整体建筑感风格建议。'
  else seed_prompt
end
where seed_prompt = '';

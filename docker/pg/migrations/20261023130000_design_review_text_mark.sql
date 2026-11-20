-- 标注新增文本/标记两种形态；文本内容随行存储。
alter table public.design_review_annotations
  drop constraint if exists design_review_annotations_kind_check;

alter table public.design_review_annotations
  add constraint design_review_annotations_kind_check
  check (kind in ('pen', 'rect', 'text', 'mark'));

alter table public.design_review_annotations
  add column if not exists text text
  check (text is null or length(text) <= 500);

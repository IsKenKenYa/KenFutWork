-- 前台子任务仍持久化/参与并发，但结果由原SDK调用返回，不产生后台通知。
ALTER TABLE public.task_works ADD COLUMN detached boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.task_works.detached IS '后台命令/子任务为true；前台子任务为false，初始抑制mailbox通知';

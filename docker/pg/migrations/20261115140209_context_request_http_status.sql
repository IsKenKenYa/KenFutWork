ALTER TABLE public.context_model_requests
  ADD COLUMN http_status smallint
  CHECK (http_status IS NULL OR (status = 'failed' AND http_status BETWEEN 400 AND 599));
COMMENT ON COLUMN public.context_model_requests.http_status IS '供应商 SDK 返回的数字 HTTP 错误状态，不保留错误正文或响应头';

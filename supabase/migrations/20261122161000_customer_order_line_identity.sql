-- LINE 身分綁定與單筆訂單查詢授權；只新增 nullable 欄位，不改寫既有訂單。
ALTER TABLE public.customer_orders
  ADD COLUMN IF NOT EXISTS line_user_id text,
  ADD COLUMN IF NOT EXISTS line_display_name text,
  ADD COLUMN IF NOT EXISTS status_token_hash text;

CREATE INDEX IF NOT EXISTS customer_orders_line_user_id_created_at_idx
  ON public.customer_orders (line_user_id, created_at DESC)
  WHERE line_user_id IS NOT NULL;

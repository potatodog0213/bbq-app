BEGIN;

ALTER TABLE public.customer_orders
    ADD COLUMN IF NOT EXISTS confirmed_at timestamptz,
    ADD COLUMN IF NOT EXISTS preparing_at timestamptz,
    ADD COLUMN IF NOT EXISTS completed_at timestamptz,
    ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

COMMENT ON COLUMN public.customer_orders.confirmed_at IS '店家確認訂單的時間';
COMMENT ON COLUMN public.customer_orders.preparing_at IS '店家開始製作的時間';
COMMENT ON COLUMN public.customer_orders.completed_at IS '店家完成訂單的時間';
COMMENT ON COLUMN public.customer_orders.cancelled_at IS '店家取消訂單的時間';

COMMIT;

-- 馬鈴吉碳烤：公開訂單 API 頻率限制與餐點照片儲存
-- 新增獨立安全紀錄表與 Storage bucket；不更新、刪除或搬動任何既有訂單／產品資料。

BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_order_rate_limits (
  bucket_key text PRIMARY KEY,
  window_started_at timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  reset_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customer_order_rate_limits_updated_at_idx
  ON public.customer_order_rate_limits (updated_at);
ALTER TABLE public.customer_order_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.customer_order_rate_limits FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.customer_order_rate_limits TO service_role;

CREATE OR REPLACE FUNCTION public.consume_customer_order_rate_limit(
  p_key text, p_limit integer, p_window_seconds integer
)
RETURNS TABLE(allowed boolean, remaining integer, reset_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE v_row public.customer_order_rate_limits%ROWTYPE;
BEGIN
  IF p_key IS NULL OR length(p_key) < 8 OR length(p_key) > 200
     OR p_limit IS NULL OR p_limit < 1 OR p_limit > 10000
     OR p_window_seconds IS NULL OR p_window_seconds < 1 OR p_window_seconds > 86400 THEN
    RAISE EXCEPTION 'Invalid rate limit parameters' USING ERRCODE = '22023';
  END IF;

  INSERT INTO public.customer_order_rate_limits AS rl
    (bucket_key, window_started_at, request_count, reset_at, updated_at)
  VALUES (p_key, now(), 1, now() + make_interval(secs => p_window_seconds), now())
  ON CONFLICT (bucket_key) DO UPDATE SET
    window_started_at = CASE WHEN rl.reset_at <= now() THEN now() ELSE rl.window_started_at END,
    request_count = CASE WHEN rl.reset_at <= now() THEN 1 ELSE rl.request_count + 1 END,
    reset_at = CASE WHEN rl.reset_at <= now() THEN now() + make_interval(secs => p_window_seconds) ELSE rl.reset_at END,
    updated_at = now()
  RETURNING * INTO v_row;

  RETURN QUERY SELECT v_row.request_count <= p_limit,
    greatest(p_limit - v_row.request_count, 0), v_row.reset_at;

  -- 清除已過期的 IP／電話限流 key，避免表長期累積；不涉及任何訂單資料。
  IF random() < 0.01 THEN
    DELETE FROM public.customer_order_rate_limits WHERE updated_at < now() - interval '2 days';
  END IF;
END;
$function$;
REVOKE ALL ON FUNCTION public.consume_customer_order_rate_limit(text, integer, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.consume_customer_order_rate_limit(text, integer, integer) TO service_role;

COMMIT;

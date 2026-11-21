-- 馬鈴吉碳烤｜客人直接修改原訂單 RPC 修復
-- 執行位置：Supabase Dashboard → SQL Editor
-- 僅建立／更新此 RPC，不新增訂單、不重編流水號、不變更取餐時間。

BEGIN;

CREATE OR REPLACE FUNCTION public.edit_customer_order_direct_atomic(
    p_order_id uuid,
    p_customer_phone text,
    p_new_items jsonb,
    p_new_base_total numeric
)
RETURNS TABLE(new_total numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $function$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_addon_total numeric := 0;
    v_final_total numeric;
BEGIN
    -- 驗證必要參數與金額，拒絕 NULL、負數及非有限 numeric。
    IF p_order_id IS NULL
       OR p_customer_phone IS NULL
       OR p_customer_phone !~ '^09[0-9]{8}$' THEN
        RAISE EXCEPTION '訂單資料不正確' USING ERRCODE = '22023';
    END IF;

    IF p_new_base_total IS NULL
       OR p_new_base_total < 0
       OR p_new_base_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION '訂單金額不合理' USING ERRCODE = '22023';
    END IF;

    IF p_new_items IS NULL
       OR jsonb_typeof(p_new_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_new_items) = 0 THEN
        RAISE EXCEPTION '訂單至少要保留一項餐點' USING ERRCODE = '22023';
    END IF;

    -- 先鎖定原訂單，再以訂單 ID + 手機號碼確認所有權。
    SELECT *
      INTO v_order
      FROM public.customer_orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND OR v_order.customer_phone IS DISTINCT FROM p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '此訂單目前狀態無法修改餐點' USING ERRCODE = '55000';
    END IF;

    IF v_order.pickup_time IS NULL
       OR v_order.pickup_time <= now() + interval '15 minutes' THEN
        RAISE EXCEPTION '距離預定取餐時間不足 15 分鐘，已無法修改餐點' USING ERRCODE = '55000';
    END IF;

    -- 加點紀錄獨立保存；重算時將所有既有加點金額加回去。
    SELECT COALESCE(SUM(a.total_amount), 0)
      INTO v_addon_total
      FROM public.customer_order_addons AS a
     WHERE a.order_id = p_order_id;

    IF v_addon_total < 0 OR v_addon_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION '原訂單加點金額資料異常' USING ERRCODE = '22023';
    END IF;

    v_final_total := round((p_new_base_total + v_addon_total)::numeric, 2);

    -- 保留目前專案既有的 audit 欄位結構與寫入方式。
    INSERT INTO public.customer_order_change_audit (
        order_id,
        request_id,
        actor_type,
        old_items,
        new_items,
        old_total_amount,
        new_total_amount,
        old_note,
        new_note,
        old_pickup_time,
        new_pickup_time
    ) VALUES (
        p_order_id,
        NULL,
        'customer',
        v_order.items,
        p_new_items,
        v_order.total_amount,
        v_final_total,
        COALESCE(v_order.note, ''),
        COALESCE(v_order.note, ''),
        v_order.pickup_time,
        v_order.pickup_time
    );

    -- 只更新餐點與總金額。id、created_at、daily_sequence、pickup_time、
    -- customer_phone、status、note 及其他欄位均不會被覆寫。
    UPDATE public.customer_orders
       SET items = p_new_items,
           total_amount = v_final_total
     WHERE id = p_order_id;

    RETURN QUERY SELECT v_final_total;
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_customer_order_direct_atomic(uuid, text, jsonb, numeric)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_customer_order_direct_atomic(uuid, text, jsonb, numeric)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

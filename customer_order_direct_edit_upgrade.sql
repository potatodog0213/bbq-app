BEGIN;

-- 新訂單的取餐時間必須嚴格大於現在 10 分鐘。
CREATE OR REPLACE FUNCTION public.create_customer_order_atomic(
    p_customer_name text, p_customer_phone text, p_pickup_time timestamptz,
    p_items jsonb, p_total_amount numeric, p_note text
)
RETURNS TABLE(id uuid, created_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_id uuid; v_created_at timestamptz;
BEGIN
    IF p_pickup_time <= now() + interval '10 minutes' THEN
        RAISE EXCEPTION '取餐時間必須在現在 10 分鐘之後' USING ERRCODE = '55000';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_phone, 0));
    IF EXISTS (SELECT 1 FROM public.customer_orders WHERE customer_phone = p_customer_phone AND status IN ('new','confirmed','preparing')) THEN
        RAISE EXCEPTION '此手機號碼已有尚未完成的訂單，請使用加點功能或先完成原訂單' USING ERRCODE = '23505';
    END IF;
    INSERT INTO public.customer_orders (customer_name,customer_phone,pickup_time,items,total_amount,note,status)
    VALUES (p_customer_name,p_customer_phone,p_pickup_time,p_items,p_total_amount,p_note,'new')
    RETURNING customer_orders.id,customer_orders.created_at INTO v_id,v_created_at;
    RETURN QUERY SELECT v_id,v_created_at;
END; $$;

-- 加點同樣受取餐前 10 分鐘限制，並保留原本的獨立加點紀錄。
CREATE OR REPLACE FUNCTION public.add_customer_order_addon_atomic(
    p_order_id uuid, p_customer_phone text, p_idempotency_key text, p_items jsonb, p_total_amount numeric
)
RETURNS TABLE(addon_id uuid, created_at timestamptz, order_total numeric, was_duplicate boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE v_order public.customer_orders%ROWTYPE; v_addon public.customer_order_addons%ROWTYPE;
BEGIN
    SELECT * INTO v_order FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
    IF NOT FOUND OR v_order.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_addon FROM public.customer_order_addons WHERE order_id=p_order_id AND idempotency_key=p_idempotency_key;
    IF FOUND THEN RETURN QUERY SELECT v_addon.id,v_addon.created_at,v_order.total_amount,true; RETURN; END IF;
    IF v_order.status NOT IN ('new','confirmed','preparing') THEN
        RAISE EXCEPTION '此訂單已結束，無法加點' USING ERRCODE = '55000';
    END IF;
    IF v_order.pickup_time <= now() + interval '10 minutes' THEN
        RAISE EXCEPTION '距離預定取餐時間不足 10 分鐘，已無法加點' USING ERRCODE = '55000';
    END IF;
    INSERT INTO public.customer_order_addons(order_id,customer_phone,idempotency_key,items,total_amount)
    VALUES(p_order_id,p_customer_phone,p_idempotency_key,p_items,p_total_amount) RETURNING * INTO v_addon;
    UPDATE public.customer_orders SET total_amount=total_amount+p_total_amount WHERE id=p_order_id RETURNING * INTO v_order;
    RETURN QUERY SELECT v_addon.id,v_addon.created_at,v_order.total_amount,false;
END; $$;

-- 顧客直接調整原訂單餐點；資料庫鎖定訂單後再次檢查手機、狀態及取餐截止時間。
CREATE OR REPLACE FUNCTION public.edit_customer_order_direct_atomic(
    p_order_id uuid, p_customer_phone text, p_new_items jsonb, p_new_base_total numeric
)
RETURNS TABLE(new_total numeric)
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_addon_total numeric;
    v_final_total numeric;
    v_gifts jsonb;
    v_final_items jsonb;
BEGIN
    SELECT * INTO v_order FROM public.customer_orders WHERE id=p_order_id FOR UPDATE;
    IF NOT FOUND OR v_order.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;
    IF v_order.status NOT IN ('new','confirmed','preparing') THEN
        RAISE EXCEPTION '此訂單目前狀態無法修改餐點' USING ERRCODE = '55000';
    END IF;
    IF v_order.pickup_time <= now() + interval '10 minutes' THEN
        RAISE EXCEPTION '距離預定取餐時間不足 10 分鐘，已無法修改餐點' USING ERRCODE = '55000';
    END IF;
    IF jsonb_typeof(p_new_items) <> 'array' OR jsonb_array_length(p_new_items)=0 THEN
        RAISE EXCEPTION '訂單至少要保留一項餐點' USING ERRCODE = '22023';
    END IF;
    SELECT COALESCE(jsonb_agg(item), '[]'::jsonb) INTO v_gifts
    FROM jsonb_array_elements(COALESCE(v_order.items,'[]'::jsonb)) AS gift(item)
    WHERE gift.item->>'is_gift'='true';
    v_final_items := p_new_items || COALESCE(v_gifts,'[]'::jsonb);
    SELECT COALESCE(SUM(total_amount),0) INTO v_addon_total
    FROM public.customer_order_addons WHERE order_id=p_order_id;
    v_final_total := round((p_new_base_total + v_addon_total)::numeric,2);

    INSERT INTO public.customer_order_change_audit(
        order_id,request_id,actor_type,old_items,new_items,old_total_amount,new_total_amount,
        old_note,new_note,old_pickup_time,new_pickup_time
    ) VALUES (
        p_order_id,NULL,'customer',v_order.items,v_final_items,v_order.total_amount,v_final_total,
        COALESCE(v_order.note,''),COALESCE(v_order.note,''),v_order.pickup_time,v_order.pickup_time
    );
    UPDATE public.customer_orders SET items=v_final_items,total_amount=v_final_total WHERE id=p_order_id;
    RETURN QUERY SELECT v_final_total;
END; $$;

REVOKE ALL ON FUNCTION public.edit_customer_order_direct_atomic(uuid,text,jsonb,numeric) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.edit_customer_order_direct_atomic(uuid,text,jsonb,numeric) TO service_role;

COMMIT;

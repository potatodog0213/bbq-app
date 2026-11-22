-- LINE 身分授權：將既有顧客訂單修改 RPC 的第二個參數改為已由 Edge Function 驗證的 LINE userId。
-- 保留函數簽章與參數名稱以維持 PostgREST 相容；p_customer_phone 僅作為舊參數名稱，不再代表電話。
-- 不更新、刪除或搬動任何既有訂單資料。

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
    IF p_order_id IS NULL
       OR p_customer_phone IS NULL
       OR p_customer_phone !~ '^U[0-9a-fA-F]{32}$' THEN
        RAISE EXCEPTION 'Invalid LINE identity'
            USING ERRCODE = '22023';
    END IF;

    IF p_new_base_total IS NULL
       OR p_new_base_total < 0
       OR p_new_base_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'Invalid order total' USING ERRCODE = '22023';
    END IF;

    IF p_new_items IS NULL
       OR jsonb_typeof(p_new_items) IS DISTINCT FROM 'array'
       OR jsonb_array_length(p_new_items) = 0 THEN
        RAISE EXCEPTION 'Invalid order items' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_order
      FROM public.customer_orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND OR v_order.line_user_id IS DISTINCT FROM p_customer_phone THEN
        RAISE EXCEPTION 'Order not found or LINE identity does not match' USING ERRCODE = 'P0002';
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION 'Order status does not allow editing' USING ERRCODE = '55000';
    END IF;

    IF v_order.pickup_time IS NULL
       OR v_order.pickup_time <= now() + interval '15 minutes' THEN
        RAISE EXCEPTION 'Order cannot be edited within 15 minutes of pickup' USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(SUM(a.total_amount), 0) INTO v_addon_total
      FROM public.customer_order_addons AS a
     WHERE a.order_id = p_order_id;

    IF v_addon_total < 0 OR v_addon_total::text IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'Invalid addon total' USING ERRCODE = '22023';
    END IF;

    v_final_total := round((p_new_base_total + v_addon_total)::numeric, 2);

    INSERT INTO public.customer_order_change_audit (
        order_id, request_id, actor_type, old_items, new_items,
        old_total_amount, new_total_amount, old_note, new_note,
        old_pickup_time, new_pickup_time
    ) VALUES (
        p_order_id, NULL, 'customer', v_order.items, p_new_items,
        v_order.total_amount, v_final_total, COALESCE(v_order.note, ''),
        COALESCE(v_order.note, ''), v_order.pickup_time, v_order.pickup_time
    );

    UPDATE public.customer_orders
       SET items = p_new_items, total_amount = v_final_total
     WHERE id = p_order_id;

    RETURN QUERY SELECT v_final_total;
END;
$function$;

CREATE OR REPLACE FUNCTION public.create_customer_order_change_request_atomic(
    p_order_id uuid,
    p_customer_phone text,
    p_proposal_text text,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_id uuid;
BEGIN
    IF p_customer_phone IS NULL OR p_customer_phone !~ '^U[0-9a-fA-F]{32}$' THEN
        RAISE EXCEPTION 'Invalid LINE identity' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_order
      FROM public.customer_orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND OR v_order.line_user_id IS DISTINCT FROM p_customer_phone THEN
        RAISE EXCEPTION 'Order not found or LINE identity does not match' USING ERRCODE = 'P0002';
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION 'Order status does not allow change request' USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.customer_order_change_requests
         WHERE order_id = p_order_id AND status IN ('pending', 'approved')
    ) THEN
        RAISE EXCEPTION 'An order change request is already pending' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.customer_order_change_requests (
        order_id, customer_phone, proposal_text, reason
    ) VALUES (
        p_order_id, v_order.customer_phone, p_proposal_text, p_reason
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.issue_customer_order_change_token_atomic(
    p_request_id uuid,
    p_customer_phone text,
    p_capability_hash text,
    p_expires_at timestamp with time zone
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
    v_request public.customer_order_change_requests%ROWTYPE;
    v_order public.customer_orders%ROWTYPE;
BEGIN
    IF p_customer_phone IS NULL OR p_customer_phone !~ '^U[0-9a-fA-F]{32}$'
       OR p_capability_hash IS NULL OR p_expires_at IS NULL OR p_expires_at <= now() THEN
        RAISE EXCEPTION 'Invalid LINE authorization' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_request
      FROM public.customer_order_change_requests
     WHERE id = p_request_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Change request not found' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_order
      FROM public.customer_orders
     WHERE id = v_request.order_id
     FOR UPDATE;

    IF NOT FOUND OR v_order.line_user_id IS DISTINCT FROM p_customer_phone THEN
        RAISE EXCEPTION 'LINE identity does not match this order' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_request
      FROM public.customer_order_change_requests
     WHERE id = p_request_id
     FOR UPDATE;

    IF v_request.status <> 'approved' THEN
        RAISE EXCEPTION 'Change request is not approved' USING ERRCODE = '55000';
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION 'Order status does not allow editing' USING ERRCODE = '55000';
    END IF;

    IF v_request.expires_at IS NOT NULL AND v_request.expires_at <= now() THEN
        RAISE EXCEPTION 'Change authorization has expired' USING ERRCODE = '55000';
    END IF;

    UPDATE public.customer_order_change_requests
       SET capability_hash = p_capability_hash, expires_at = p_expires_at
     WHERE id = p_request_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_customer_order_change_atomic(
    p_order_id uuid,
    p_customer_phone text,
    p_capability_hash text,
    p_new_items jsonb,
    p_new_base_total numeric,
    p_new_note text
)
RETURNS TABLE(new_total numeric)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_request public.customer_order_change_requests%ROWTYPE;
    v_addon_total numeric;
    v_final_total numeric;
BEGIN
    IF p_customer_phone IS NULL OR p_customer_phone !~ '^U[0-9a-fA-F]{32}$' THEN
        RAISE EXCEPTION 'Invalid LINE identity' USING ERRCODE = '22023';
    END IF;

    SELECT * INTO v_order
      FROM public.customer_orders
     WHERE id = p_order_id
     FOR UPDATE;

    IF NOT FOUND OR v_order.line_user_id IS DISTINCT FROM p_customer_phone THEN
        RAISE EXCEPTION 'Order not found or LINE identity does not match' USING ERRCODE = 'P0002';
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION 'Order status does not allow editing' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_request
      FROM public.customer_order_change_requests
     WHERE order_id = p_order_id
       AND status = 'approved'
       AND capability_hash = p_capability_hash
     ORDER BY reviewed_at DESC
     LIMIT 1
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Change authorization is invalid or already used' USING ERRCODE = '42501';
    END IF;

    IF v_request.expires_at IS NULL OR v_request.expires_at <= now() THEN
        RAISE EXCEPTION 'Change authorization has expired' USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(SUM(total_amount), 0) INTO v_addon_total
      FROM public.customer_order_addons
     WHERE order_id = p_order_id;

    v_final_total := round((p_new_base_total + v_addon_total)::numeric, 2);

    INSERT INTO public.customer_order_change_audit (
        order_id, request_id, actor_type, old_items, new_items,
        old_total_amount, new_total_amount, old_note, new_note,
        old_pickup_time, new_pickup_time
    ) VALUES (
        p_order_id, v_request.id, 'customer', v_order.items, p_new_items,
        v_order.total_amount, v_final_total, v_order.note,
        COALESCE(p_new_note, v_order.note), v_order.pickup_time, v_order.pickup_time
    );

    UPDATE public.customer_orders
       SET items = p_new_items,
           total_amount = v_final_total,
           note = COALESCE(p_new_note, note)
     WHERE id = p_order_id;

    UPDATE public.customer_order_change_requests
       SET status = 'completed', completed_at = now(), capability_hash = NULL
     WHERE id = v_request.id;

    RETURN QUERY SELECT v_final_total;
END;
$function$;

REVOKE ALL ON FUNCTION public.edit_customer_order_direct_atomic(uuid, text, jsonb, numeric)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.edit_customer_order_direct_atomic(uuid, text, jsonb, numeric)
    TO service_role;

REVOKE ALL ON FUNCTION public.create_customer_order_change_request_atomic(uuid, text, text, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_customer_order_change_request_atomic(uuid, text, text, text)
    TO service_role;

REVOKE ALL ON FUNCTION public.issue_customer_order_change_token_atomic(uuid, text, text, timestamptz)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.issue_customer_order_change_token_atomic(uuid, text, text, timestamptz)
    TO service_role;

REVOKE ALL ON FUNCTION public.apply_customer_order_change_atomic(uuid, text, text, jsonb, numeric, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_customer_order_change_atomic(uuid, text, text, jsonb, numeric, text)
    TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;

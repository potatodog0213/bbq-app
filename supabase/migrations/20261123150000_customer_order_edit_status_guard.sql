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

    IF v_order.status NOT IN ('new', 'confirmed') THEN
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

COMMIT;

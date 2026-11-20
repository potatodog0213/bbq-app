BEGIN;

CREATE TABLE IF NOT EXISTS public.customer_order_addons (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
    customer_phone text NOT NULL,
    idempotency_key text NOT NULL,
    items jsonb NOT NULL DEFAULT '[]'::jsonb,
    total_amount numeric NOT NULL DEFAULT 0 CHECK (total_amount >= 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT customer_order_addons_order_idempotency_key UNIQUE (order_id, idempotency_key),
    CONSTRAINT customer_order_addons_items_array CHECK (jsonb_typeof(items) = 'array')
);

CREATE INDEX IF NOT EXISTS customer_order_addons_order_created_idx
    ON public.customer_order_addons (order_id, created_at ASC);

CREATE TABLE IF NOT EXISTS public.customer_order_change_requests (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
    customer_phone text NOT NULL,
    proposal_text text NOT NULL,
    reason text NOT NULL,
    status text NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'approved', 'rejected', 'completed', 'expired')),
    requested_at timestamptz NOT NULL DEFAULT now(),
    reviewed_at timestamptz,
    reviewed_by uuid,
    expires_at timestamptz,
    capability_hash text,
    completed_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS customer_order_change_requests_one_open_idx
    ON public.customer_order_change_requests (order_id)
    WHERE status IN ('pending', 'approved');

CREATE INDEX IF NOT EXISTS customer_order_change_requests_order_requested_idx
    ON public.customer_order_change_requests (order_id, requested_at DESC);

CREATE TABLE IF NOT EXISTS public.customer_order_change_audit (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
    request_id uuid REFERENCES public.customer_order_change_requests(id) ON DELETE SET NULL,
    actor_type text NOT NULL DEFAULT 'customer' CHECK (actor_type IN ('customer', 'store_owner', 'system')),
    old_items jsonb NOT NULL,
    new_items jsonb NOT NULL,
    old_total_amount numeric NOT NULL,
    new_total_amount numeric NOT NULL,
    old_note text NOT NULL DEFAULT '',
    new_note text NOT NULL DEFAULT '',
    old_pickup_time timestamptz NOT NULL,
    new_pickup_time timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS customer_order_change_audit_order_created_idx
    ON public.customer_order_change_audit (order_id, created_at DESC);

ALTER TABLE public.customer_order_addons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.customer_order_change_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.customer_order_addons, public.customer_order_change_requests, public.customer_order_change_audit FROM anon, authenticated;
GRANT SELECT ON public.customer_order_addons, public.customer_order_change_requests, public.customer_order_change_audit TO authenticated;
GRANT ALL ON public.customer_order_addons, public.customer_order_change_requests, public.customer_order_change_audit TO service_role;

CREATE OR REPLACE FUNCTION public.invalidate_customer_order_change_capabilities()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.status IN ('completed', 'cancelled') AND OLD.status IS DISTINCT FROM NEW.status THEN
        UPDATE public.customer_order_change_requests
        SET status = CASE WHEN status IN ('pending', 'approved') THEN 'expired' ELSE status END,
            capability_hash = NULL,
            expires_at = NULL
        WHERE order_id = NEW.id
          AND status IN ('pending', 'approved');
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS customer_order_invalidate_change_capabilities ON public.customer_orders;
CREATE TRIGGER customer_order_invalidate_change_capabilities
AFTER UPDATE OF status ON public.customer_orders
FOR EACH ROW
EXECUTE FUNCTION public.invalidate_customer_order_change_capabilities();

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'customer_order_addons'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_order_addons;
        END IF;
        IF NOT EXISTS (
            SELECT 1 FROM pg_publication_tables
            WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'customer_order_change_requests'
        ) THEN
            ALTER PUBLICATION supabase_realtime ADD TABLE public.customer_order_change_requests;
        END IF;
    END IF;
END;
$$;

DROP POLICY IF EXISTS "store owner can read customer order addons" ON public.customer_order_addons;
CREATE POLICY "store owner can read customer order addons"
ON public.customer_order_addons FOR SELECT TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');

DROP POLICY IF EXISTS "store owner can read customer order change requests" ON public.customer_order_change_requests;
CREATE POLICY "store owner can read customer order change requests"
ON public.customer_order_change_requests FOR SELECT TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');

DROP POLICY IF EXISTS "store owner can read customer order change audit" ON public.customer_order_change_audit;
CREATE POLICY "store owner can read customer order change audit"
ON public.customer_order_change_audit FOR SELECT TO authenticated
USING ((auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');

CREATE OR REPLACE FUNCTION public.create_customer_order_atomic(
    p_customer_name text,
    p_customer_phone text,
    p_pickup_time timestamptz,
    p_items jsonb,
    p_total_amount numeric,
    p_note text
)
RETURNS TABLE(id uuid, created_at timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid;
    v_created_at timestamptz;
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended(p_customer_phone, 0));

    IF EXISTS (
        SELECT 1 FROM public.customer_orders
        WHERE customer_phone = p_customer_phone
          AND status IN ('new', 'confirmed', 'preparing')
    ) THEN
        RAISE EXCEPTION '此手機號碼已有尚未完成的訂單，請使用加點功能或先完成原訂單'
            USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.customer_orders (
        customer_name, customer_phone, pickup_time, items, total_amount, note, status
    ) VALUES (
        p_customer_name, p_customer_phone, p_pickup_time, p_items, p_total_amount, p_note, 'new'
    ) RETURNING customer_orders.id, customer_orders.created_at
    INTO v_id, v_created_at;

    RETURN QUERY SELECT v_id, v_created_at;
END;
$$;

CREATE OR REPLACE FUNCTION public.add_customer_order_addon_atomic(
    p_order_id uuid,
    p_customer_phone text,
    p_idempotency_key text,
    p_items jsonb,
    p_total_amount numeric
)
RETURNS TABLE(addon_id uuid, created_at timestamptz, order_total numeric, was_duplicate boolean)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_addon public.customer_order_addons%ROWTYPE;
BEGIN
    SELECT * INTO v_order
    FROM public.customer_orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND OR v_order.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;

    SELECT * INTO v_addon
    FROM public.customer_order_addons
    WHERE order_id = p_order_id AND idempotency_key = p_idempotency_key;

    IF FOUND THEN
        RETURN QUERY SELECT v_addon.id, v_addon.created_at, v_order.total_amount, true;
        RETURN;
    END IF;

    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '此訂單已結束，無法加點' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.customer_order_addons (
        order_id, customer_phone, idempotency_key, items, total_amount
    ) VALUES (
        p_order_id, p_customer_phone, p_idempotency_key, p_items, p_total_amount
    ) RETURNING * INTO v_addon;

    UPDATE public.customer_orders
    SET total_amount = total_amount + p_total_amount
    WHERE id = p_order_id
    RETURNING * INTO v_order;

    RETURN QUERY SELECT v_addon.id, v_addon.created_at, v_order.total_amount, false;
END;
$$;

CREATE OR REPLACE FUNCTION public.create_customer_order_change_request_atomic(
    p_order_id uuid,
    p_customer_phone text,
    p_proposal_text text,
    p_reason text
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_id uuid;
BEGIN
    SELECT * INTO v_order
    FROM public.customer_orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND OR v_order.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;
    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '此訂單已結束，無法申請修改' USING ERRCODE = '55000';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.customer_order_change_requests
        WHERE order_id = p_order_id AND status IN ('pending', 'approved')
    ) THEN
        RAISE EXCEPTION '此訂單已有待審核的修改申請' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.customer_order_change_requests (
        order_id, customer_phone, proposal_text, reason
    ) VALUES (
        p_order_id, p_customer_phone, p_proposal_text, p_reason
    ) RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.review_customer_order_change_request_atomic(
    p_request_id uuid,
    p_owner_id uuid,
    p_approved boolean,
    p_capability_hash text,
    p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_request public.customer_order_change_requests%ROWTYPE;
    v_order public.customer_orders%ROWTYPE;
BEGIN
    SELECT * INTO v_request
    FROM public.customer_order_change_requests
    WHERE id = p_request_id;
    IF NOT FOUND THEN RAISE EXCEPTION '找不到修改申請' USING ERRCODE = 'P0002'; END IF;

    SELECT * INTO v_order
    FROM public.customer_orders
    WHERE id = v_request.order_id
    FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '找不到訂單' USING ERRCODE = 'P0002'; END IF;

    SELECT * INTO v_request
    FROM public.customer_order_change_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF v_request.status <> 'pending' THEN
        RAISE EXCEPTION '此修改申請已經處理' USING ERRCODE = '55000';
    END IF;
    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '訂單已結束，無法審核修改' USING ERRCODE = '55000';
    END IF;

    UPDATE public.customer_order_change_requests
    SET status = CASE WHEN p_approved THEN 'approved' ELSE 'rejected' END,
        reviewed_at = now(),
        reviewed_by = p_owner_id,
        capability_hash = CASE WHEN p_approved THEN p_capability_hash ELSE NULL END,
        expires_at = CASE WHEN p_approved THEN p_expires_at ELSE NULL END
    WHERE id = p_request_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.issue_customer_order_change_token_atomic(
    p_request_id uuid,
    p_customer_phone text,
    p_capability_hash text,
    p_expires_at timestamptz
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_request public.customer_order_change_requests%ROWTYPE;
    v_order public.customer_orders%ROWTYPE;
BEGIN
    SELECT * INTO v_request
    FROM public.customer_order_change_requests
    WHERE id = p_request_id;
    IF NOT FOUND OR v_request.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的修改申請' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_order FROM public.customer_orders WHERE id = v_request.order_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '找不到訂單' USING ERRCODE = 'P0002'; END IF;
    SELECT * INTO v_request
    FROM public.customer_order_change_requests
    WHERE id = p_request_id
    FOR UPDATE;
    IF v_request.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的修改申請' USING ERRCODE = 'P0002';
    END IF;
    IF v_request.status <> 'approved' THEN
        RAISE EXCEPTION '此修改申請尚未核准或已失效' USING ERRCODE = '55000';
    END IF;
    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '訂單已結束，修改授權失效' USING ERRCODE = '55000';
    END IF;
    IF v_request.expires_at IS NOT NULL AND v_request.expires_at <= now() THEN
        RAISE EXCEPTION '修改授權已過期，請聯絡店家重新審核' USING ERRCODE = '55000';
    END IF;

    UPDATE public.customer_order_change_requests
    SET capability_hash = p_capability_hash,
        expires_at = p_expires_at
    WHERE id = p_request_id;
END;
$$;

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
SET search_path = public, pg_temp
AS $$
DECLARE
    v_order public.customer_orders%ROWTYPE;
    v_request public.customer_order_change_requests%ROWTYPE;
    v_addon_total numeric;
    v_final_total numeric;
BEGIN
    SELECT * INTO v_order
    FROM public.customer_orders
    WHERE id = p_order_id
    FOR UPDATE;

    IF NOT FOUND OR v_order.customer_phone <> p_customer_phone THEN
        RAISE EXCEPTION '找不到符合手機號碼的訂單' USING ERRCODE = 'P0002';
    END IF;
    IF v_order.status NOT IN ('new', 'confirmed', 'preparing') THEN
        RAISE EXCEPTION '此訂單已結束，修改授權失效' USING ERRCODE = '55000';
    END IF;

    SELECT * INTO v_request
    FROM public.customer_order_change_requests
    WHERE order_id = p_order_id
      AND customer_phone = p_customer_phone
      AND status = 'approved'
      AND capability_hash = p_capability_hash
    ORDER BY reviewed_at DESC
    LIMIT 1
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION '修改授權不正確或已使用' USING ERRCODE = '42501';
    END IF;
    IF v_request.expires_at IS NULL OR v_request.expires_at <= now() THEN
        RAISE EXCEPTION '修改授權已過期' USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(SUM(total_amount), 0) INTO v_addon_total
    FROM public.customer_order_addons
    WHERE order_id = p_order_id;

    v_final_total := round((p_new_base_total + v_addon_total)::numeric, 2);

    INSERT INTO public.customer_order_change_audit (
        order_id, request_id, actor_type,
        old_items, new_items, old_total_amount, new_total_amount,
        old_note, new_note, old_pickup_time, new_pickup_time
    ) VALUES (
        p_order_id, v_request.id, 'customer',
        v_order.items, p_new_items, v_order.total_amount, v_final_total,
        v_order.note, COALESCE(p_new_note, v_order.note),
        v_order.pickup_time, v_order.pickup_time
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
$$;

REVOKE ALL ON FUNCTION public.create_customer_order_atomic(text, text, timestamptz, jsonb, numeric, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.add_customer_order_addon_atomic(uuid, text, text, jsonb, numeric) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_customer_order_change_request_atomic(uuid, text, text, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.review_customer_order_change_request_atomic(uuid, uuid, boolean, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.issue_customer_order_change_token_atomic(uuid, text, text, timestamptz) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_customer_order_change_atomic(uuid, text, text, jsonb, numeric, text) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.create_customer_order_atomic(text, text, timestamptz, jsonb, numeric, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.add_customer_order_addon_atomic(uuid, text, text, jsonb, numeric) TO service_role;
GRANT EXECUTE ON FUNCTION public.create_customer_order_change_request_atomic(uuid, text, text, text) TO service_role;
GRANT EXECUTE ON FUNCTION public.review_customer_order_change_request_atomic(uuid, uuid, boolean, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.issue_customer_order_change_token_atomic(uuid, text, text, timestamptz) TO service_role;
GRANT EXECUTE ON FUNCTION public.apply_customer_order_change_atomic(uuid, text, text, jsonb, numeric, text) TO service_role;

COMMIT;

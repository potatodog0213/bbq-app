import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { ...cors, "Content-Type": "application/json" },
});
const META_PREFIX = "\n\n[[MALINJI_ORDER_META:";
const META_SUFFIX = "]]";
function readNote(raw: string) {
  const at = raw.lastIndexOf(META_PREFIX);
  if (at < 0) return { customerNote: raw, meta: {} as Record<string, unknown> };
  const end = raw.indexOf(META_SUFFIX, at);
  if (end < 0) return { customerNote: raw, meta: {} as Record<string, unknown> };
  try {
    const meta = JSON.parse(raw.slice(at + META_PREFIX.length, end));
    return { customerNote: raw.slice(0, at), meta: meta && typeof meta === "object" ? meta : {} };
  } catch {
    return { customerNote: raw.slice(0, at), meta: {} as Record<string, unknown> };
  }
}
function writeNote(customerNote: string, meta: Record<string, unknown>) {
  return `${customerNote}${META_PREFIX}${JSON.stringify(meta)}${META_SUFFIX}`;
}
function taiwanHourMinute(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? -1);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? -1);
  return { hour, minute };
}
function isAllowedPickupTime(date: Date) {
  const { hour, minute } = taiwanHourMinute(date);
  return (hour === 17 && minute >= 30 && minute <= 55 && minute % 5 === 0)
    || (hour >= 18 && hour <= 23 && minute % 5 === 0)
    || ((hour === 0 || hour === 1) && minute % 5 === 0)
    || (hour === 2 && minute === 0);
}
function taiwanDateValue(date: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(date);
  const year = parts.find((p) => p.type === "year")?.value ?? "0000";
  const month = parts.find((p) => p.type === "month")?.value ?? "00";
  const day = parts.find((p) => p.type === "day")?.value ?? "00";
  return `${year}-${month}-${day}`;
}


function normalizePhone(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").replace(/^886(?=9\d{8}$)/, "0");
}
async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomCapabilityToken() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function ownerUser(req: Request, url: string, anonKey: string | undefined) {
  if (!anonKey) return null;
  const authHeader = req.headers.get("Authorization") ?? "";
  const userClient = createClient(url, anonKey, {
    global: { headers: { Authorization: authHeader } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: { user }, error } = await userClient.auth.getUser();
  if (error || user?.app_metadata?.role !== "store_owner") return null;
  return user;
}
async function notifyOwner(admin: ReturnType<typeof createClient>, title: string, message: string) {
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:store@example.com";
  if (!vapidPublic || !vapidPrivate) return;
  try {
    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const { data: subs, error } = await admin.from("customer_push_subscriptions").select("id,endpoint,p256dh,auth");
    if (error) throw error;
    const payload = JSON.stringify({ title, body: message, url: "/bbq-app/?customer-order-admin=1" });
    await Promise.allSettled((subs ?? []).map(async (sub: any) => {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("customer_push_subscriptions").delete().eq("id", sub.id);
        console.warn("[customer-orders][push] send failed", e?.statusCode ?? "unknown");
      }
    }));
  } catch (e) {
    console.warn("[customer-orders][push] delivery skipped", e);
  }
}
async function buildRegularItemSnapshot(admin: ReturnType<typeof createClient>, input: unknown) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 40) {
    throw new Error("餐點內容不正確");
  }
  const quantities = new Map<string, number>();
  const variants = new Map<string, { productId: string; spice: string | null }>();
  for (const item of input as any[]) {
    const id = String(item?.product_id ?? "").trim();
    const qty = Number(item?.quantity);
    const spice = item?.spice_level == null ? null : String(item.spice_level);
    if (!/^\d+$/.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 30) throw new Error("餐點數量不正確");
    if (spice !== null && !["不辣", "小辣", "中辣", "大辣"].includes(spice)) throw new Error("辣度選項不正確");
    const key = `${id}::${spice ?? "__none__"}`;
    quantities.set(key, (quantities.get(key) ?? 0) + qty);
    variants.set(key, { productId: id, spice });
  }
  if ([...quantities.values()].some((q) => q > 30)) throw new Error("同一餐點、同一辣度的數量超過限制");
  const ids = [...new Set([...variants.values()].map((v) => v.productId))];
  const [{ data: products, error: productError }, { data: settingsRow, error: settingsError }] = await Promise.all([
    admin.from("products").select("id,name,price").in("id", ids),
    admin.from("menu_generator_settings").select("settings_json").eq("id", "default").maybeSingle(),
  ]);
  if (productError) throw productError;
  if (settingsError) throw settingsError;
  if (!products || products.length !== ids.length) throw new Error("部分餐點已下架，請重新整理菜單");
  const settings = settingsRow?.settings_json ?? {};
  const spicySettings = settings.customerOrderSpicySettings ?? {};
  const soldOutIds = settings.customerOrderSoldOutDate === taiwanDateValue(new Date())
    ? new Set((settings.customerOrderSoldOutProductIds ?? []).map(String)) : new Set<string>();
  const productMap = new Map(products.map((p: any) => [String(p.id), p]));
  const snapshot = [...quantities.keys()].map((key) => {
    const variant = variants.get(key)!;
    const product: any = productMap.get(variant.productId);
    if (soldOutIds.has(variant.productId)) throw new Error(`「${String(product?.name ?? "餐點")}」今日已售完，請移除後重新送出`);
    const price = Number(product?.price);
    if (!product || !Number.isFinite(price) || price < 0) throw new Error("商品價格資料異常");
    const config = spicySettings[variant.productId] ?? {};
    const spicyEnabled = config.enabled !== false;
    const allowedLevels = Array.isArray(config.levels) && config.levels.length ? config.levels : ["不辣", "小辣", "中辣", "大辣"];
    if (spicyEnabled && (!variant.spice || !allowedLevels.includes(variant.spice))) throw new Error(`「${String(product.name)}」請選擇有效辣度，或重新載入菜單`);
    if (!spicyEnabled && variant.spice) throw new Error(`「${String(product.name)}」目前未開放辣度選擇，請重新載入菜單`);
    const quantity = quantities.get(key)!;
    return {
      product_id: variant.productId,
      name: String(product.name ?? "商品").slice(0, 100),
      unit_price: price,
      quantity,
      subtotal: Math.round(price * quantity * 100) / 100,
      ...(variant.spice ? { spice_level: variant.spice } : {}),
    };
  });
  const total = Math.round(snapshot.reduce((sum: number, item: any) => sum + item.subtotal, 0) * 100) / 100;
  return { snapshot, total };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ ok: false, error: "Method not allowed" }, 405);

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  if (!url || !serviceKey) return reply({ ok: false, error: "Server configuration error" }, 500);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const body = await req.json();
    const action = String(body?.action ?? "");

    if (action === "health") return reply({ ok: true, function: "customer-orders", version: "customer-order-direct-edit-20261121" });

    if (action === "lookup-orders") {
      const phone = normalizePhone(body.customer_phone);
      if (!/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "手機號碼格式不正確" }, 400);
      const { data: orders, error } = await admin.from("customer_orders")
        .select("id,items,total_amount,status,pickup_time,created_at,note")
        .eq("customer_phone", phone).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      const ids = (orders ?? []).map((o: any) => o.id);
      await admin.from("customer_order_change_requests")
        .update({ status: "expired", capability_hash: null })
        .eq("customer_phone", phone).eq("status", "approved")
        .not("expires_at", "is", null).lte("expires_at", new Date().toISOString());
      const [addonResult, requestResult] = ids.length ? await Promise.all([
        admin.from("customer_order_addons").select("id,order_id,items,total_amount,created_at").in("order_id", ids).order("created_at", { ascending: true }),
        admin.from("customer_order_change_requests").select("id,order_id,proposal_text,reason,status,requested_at,reviewed_at,expires_at,completed_at").in("order_id", ids).order("requested_at", { ascending: false }),
      ]) : [{ data: [], error: null }, { data: [], error: null }];
      if (addonResult.error) throw addonResult.error;
      if (requestResult.error) throw requestResult.error;
      const safeOrders = (orders ?? []).map((order: any) => {
        const { meta } = readNote(String(order.note ?? ""));
        return {
          id: order.id, items: order.items, total_amount: order.total_amount,
          status: order.status, pickup_time: order.pickup_time, created_at: order.created_at,
          proposed_pickup_time: typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : null,
          addons: (addonResult.data ?? []).filter((a: any) => a.order_id === order.id),
          change_requests: (requestResult.data ?? []).filter((r: any) => r.order_id === order.id),
        };
      });
      return reply({ ok: true, orders: safeOrders });
    }

    if (action === "get-order") {
      const id = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      if (!id || !/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "訂單資料不正確" }, 400);
      const { data: order, error } = await admin.from("customer_orders")
        .select("id,status,pickup_time,note").eq("id", id).eq("customer_phone", phone).maybeSingle();
      if (error) throw error;
      if (!order) return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
      const { meta } = readNote(String(order.note ?? ""));
      return reply({ ok: true, status: order.status, pickup_time: order.pickup_time,
        proposed_pickup_time: typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : null,
        customer_response: typeof meta.customer_response === "string" ? meta.customer_response : null });
    }

    // 客人回覆店家提出的時間；同意才正式寫入 pickup_time 並確認訂單。
    if (action === "respond-time") {
      const id = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      if (!id || !/^09\d{8}$/.test(phone) || typeof body.accepted !== "boolean") return reply({ ok: false, error: "回覆資料不正確" }, 400);
      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,status,pickup_time,note").eq("id", id).eq("customer_phone", phone).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "找不到訂單" }, 404);
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      const proposed = typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : "";
      if (!proposed) return reply({ ok: false, error: "目前沒有待確認的取餐時間" }, 409);
      if (body.accepted) {
        const { error } = await admin.from("customer_orders").update({
          pickup_time: proposed, status: "confirmed",
          note: writeNote(customerNote, { ...meta, proposed_pickup_time: null, customer_response: "accepted" }),
        }).eq("id", id);
        if (error) throw error;
        return reply({ ok: true, status: "confirmed", pickup_time: proposed });
      }
      const { error } = await admin.from("customer_orders").update({
        note: writeNote(customerNote, { ...meta, proposed_pickup_time: null, customer_response: "declined" }),
      }).eq("id", id);
      if (error) throw error;
      return reply({ ok: true, status: order.status, customer_response: "declined" });
    }

    if (action === "add-on-order") {
      const orderId = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      const idempotencyKey = String(body.idempotency_key ?? "").trim();
      if (!orderId || !/^09\d{8}$/.test(phone) || !/^[0-9a-f-]{36}$/i.test(idempotencyKey)) {
        return reply({ ok: false, error: "加點資料不正確，請重新操作" }, 400);
      }
      const { snapshot, total } = await buildRegularItemSnapshot(admin, body.items);
      const { data, error } = await admin.rpc("add_customer_order_addon_atomic", {
        p_order_id: orderId, p_customer_phone: phone, p_idempotency_key: idempotencyKey,
        p_items: snapshot, p_total_amount: total,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const result = Array.isArray(data) ? data[0] : data;
      if (!result?.was_duplicate) {
        const addedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
        const task = notifyOwner(admin, "馬鈴吉碳烤｜訂單加點", `訂單 ${orderId.slice(0, 8)}（${phone}）於 ${addedAt} 新增加點：${snapshot.map((i: any) => `${i.name} × ${i.quantity}${i.spice_level ? `（${i.spice_level}）` : ""}`).join("、")}；加點金額 $${total.toLocaleString("zh-TW")}。`);
        const runtime = (globalThis as any).EdgeRuntime;
        if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
      }
      return reply({ ok: true, addon_id: result?.addon_id, created_at: result?.created_at, total_amount: result?.order_total, duplicate: !!result?.was_duplicate });
    }

    // 客人直接修改原訂單餐點，不再建立申請或要求填寫原因。
    if (action === "direct-edit-order") {
      const orderId = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      if (!orderId || !/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "訂單修改資料不正確" }, 400);
      const { snapshot, total } = await buildRegularItemSnapshot(admin, body.items);
      const { data: currentOrder, error: currentError } = await admin.from("customer_orders")
        .select("id,status,pickup_time").eq("id", orderId).eq("customer_phone", phone).maybeSingle();
      if (currentError) throw currentError;
      if (!currentOrder) return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
      if (new Date(currentOrder.pickup_time).getTime() <= Date.now() + 10 * 60_000) {
        return reply({ ok: false, error: "距離預定取餐時間不足 10 分鐘，已無法修改餐點" }, 409);
      }
      const { data, error } = await admin.rpc("edit_customer_order_direct_atomic", {
        p_order_id: orderId, p_customer_phone: phone, p_new_items: snapshot, p_new_base_total: total,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const result = Array.isArray(data) ? data[0] : data;
      return reply({ ok: true, total_amount: result?.new_total });
    }

    if (action === "request-order-change") {
      const orderId = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      const proposal = String(body.proposal_text ?? "").trim();
      const reason = String(body.reason ?? "").trim();
      if (!orderId || !/^09\d{8}$/.test(phone) || !proposal || proposal.length > 500 || !reason || reason.length > 300) {
        return reply({ ok: false, error: "請填寫修改內容與原因（修改內容最多 500 字、原因最多 300 字）" }, 400);
      }
      const { data: requestId, error } = await admin.rpc("create_customer_order_change_request_atomic", {
        p_order_id: orderId, p_customer_phone: phone, p_proposal_text: proposal, p_reason: reason,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
        if (error.code === "23505") return reply({ ok: false, error: "此訂單已有待審核的修改申請" }, 409);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const requestedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
      const task = notifyOwner(admin, "馬鈴吉碳烤｜訂單修改申請", `訂單 ${orderId.slice(0, 8)}（${phone}）於 ${requestedAt} 提出修改申請：${proposal}；原因：${reason}。請至訂單管理審核。`);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
      return reply({ ok: true, request_id: requestId });
    }

    if (action === "owner-review-order-change") {
      const user = await ownerUser(req, url, anonKey);
      if (!user) return reply({ ok: false, error: "未授權的店家帳號" }, 403);
      const requestId = String(body.request_id ?? "").trim();
      if (!requestId || typeof body.approved !== "boolean") return reply({ ok: false, error: "審核資料不正確" }, 400);
      const { error } = await admin.rpc("review_customer_order_change_request_atomic", {
        p_request_id: requestId, p_owner_id: user.id, p_approved: body.approved,
        p_capability_hash: null, p_expires_at: null,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到修改申請" }, 404);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      return reply({ ok: true, status: body.approved ? "approved" : "rejected" });
    }

    // 店家更新訂單狀態。所有狀態轉換均在後端驗證，並以舊狀態作為更新條件避免競態覆寫。
    if (action === "owner-update-status") {
      const user = await ownerUser(req, url, anonKey);
      if (!user) return reply({ ok: false, error: "未授權的店家帳號" }, 403);

      const orderId = String(body.order_id ?? "").trim();
      const nextStatus = String(body.status ?? "").trim();
      const allowedTransitions: Record<string, string[]> = {
        new: ["confirmed", "cancelled"],
        confirmed: ["preparing", "cancelled"],
        preparing: ["completed"],
        completed: [],
        cancelled: [],
      };
      if (!orderId || !["confirmed", "preparing", "completed", "cancelled"].includes(nextStatus)) {
        return reply({ ok: false, error: "訂單狀態更新資料不正確" }, 400);
      }

      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,status").eq("id", orderId).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "找不到訂單" }, 404);
      const currentStatus = String(order.status ?? "");
      if (!(allowedTransitions[currentStatus] ?? []).includes(nextStatus)) {
        return reply({ ok: false, error: `目前訂單狀態（${currentStatus}）不能變更為 ${nextStatus}` }, 409);
      }

      const { data: updated, error: updateError } = await admin.from("customer_orders")
        .update({ status: nextStatus }).eq("id", orderId).eq("status", currentStatus)
        .select("id,status").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return reply({ ok: false, error: "訂單狀態已被其他操作更新，請重新整理後再試" }, 409);
      return reply({ ok: true, order_id: updated.id, status: updated.status });
    }

    if (action === "issue-order-change-token") {
      const requestId = String(body.request_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      if (!requestId || !/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "修改授權資料不正確" }, 400);
      const token = randomCapabilityToken();
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const { error } = await admin.rpc("issue_customer_order_change_token_atomic", {
        p_request_id: requestId, p_customer_phone: phone,
        p_capability_hash: tokenHash, p_expires_at: expiresAt,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到符合手機號碼的修改申請" }, 404);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      return reply({ ok: true, capability_token: token, expires_at: expiresAt });
    }

    if (action === "submit-order-change") {
      const orderId = String(body.order_id ?? "").trim();
      const phone = normalizePhone(body.customer_phone);
      const token = String(body.capability_token ?? "").trim();
      if (!orderId || !/^09\d{8}$/.test(phone) || !/^[0-9a-f]{64}$/i.test(token)) {
        return reply({ ok: false, error: "修改資料或授權碼不正確" }, 400);
      }
      const { snapshot, total } = await buildRegularItemSnapshot(admin, body.items);
      const { data: currentOrder, error: currentOrderError } = await admin.from("customer_orders")
        .select("items,note").eq("id", orderId).eq("customer_phone", phone).maybeSingle();
      if (currentOrderError) throw currentOrderError;
      if (!currentOrder) return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
      const giftItems = (Array.isArray(currentOrder.items) ? currentOrder.items : []).filter((item: any) => item?.is_gift === true);
      const finalItems = [...snapshot, ...giftItems];
      const tokenHash = await sha256Hex(token);
      const { meta: existingMeta } = readNote(String(currentOrder.note ?? ""));
      const submittedNote = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      const newNote = submittedNote ? writeNote(submittedNote, existingMeta) : null;
      const { data, error } = await admin.rpc("apply_customer_order_change_atomic", {
        p_order_id: orderId, p_customer_phone: phone, p_capability_hash: tokenHash,
        p_new_items: finalItems, p_new_base_total: total, p_new_note: newNote,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "找不到符合手機號碼的訂單" }, 404);
        if (error.code === "42501") return reply({ ok: false, error: "修改授權不正確或已使用" }, 403);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const result = Array.isArray(data) ? data[0] : data;
      return reply({ ok: true, total_amount: result?.new_total });
    }

    // 店家提出其他時間。此動作必須是已登入且授權的店家管理帳號。
    if (action === "propose-time") {
      if (!anonKey) return reply({ ok: false, error: "Server configuration error" }, 500);
      const authHeader = req.headers.get("Authorization") ?? "";
      const userClient = createClient(url, anonKey, {
        global: { headers: { Authorization: authHeader } },
        auth: { persistSession: false, autoRefreshToken: false },
      });
      const { data: { user }, error: authError } = await userClient.auth.getUser();
      if (authError || user?.app_metadata?.role !== "store_owner") return reply({ ok: false, error: "未授權的店家帳號" }, 403);
      const id = String(body.order_id ?? "").trim();
      const proposed = new Date(body.proposed_pickup_time);
      if (!id || !Number.isFinite(proposed.getTime()) || proposed.getTime() < Date.now() + 30 * 60_000 || proposed.getTime() > Date.now() + 14 * 24 * 60 * 60_000 || !isAllowedPickupTime(proposed)) {
        return reply({ ok: false, error: "請選擇至少 30 分鐘後、17:30 至隔日凌晨 02:00 的取餐時間（每 5 分鐘一個時段）" }, 400);
      }
      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,status,note").eq("id", id).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "找不到訂單" }, 404);
      if (order.status !== "new") return reply({ ok: false, error: "只有待確認訂單可以調整取餐時間" }, 409);
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      const { error } = await admin.from("customer_orders").update({
        note: writeNote(customerNote, { ...meta, proposed_pickup_time: proposed.toISOString(), customer_response: null }),
      }).eq("id", id);
      if (error) throw error;
      return reply({ ok: true });
    }

    if (action !== "create-order") return reply({ ok: false, error: "Unsupported action" }, 400);
    if (typeof body.website === "string" && body.website.trim()) return reply({ ok: true });

    const name = String(body.customer_name ?? "").trim();
    const phone = String(body.customer_phone ?? "").replace(/\D/g, "").replace(/^886(?=9\d{8}$)/, "0");
    const note = String(body.note ?? "").trim();
    const pickup = new Date(body.pickup_time);
    const input = body.items;
    if (!name || name.length > 40) return reply({ ok: false, error: "姓名格式不正確" }, 400);
    if (!/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "請填寫正確的 10 碼手機號碼（09 開頭）" }, 400);
    if (note.length > 500) return reply({ ok: false, error: "備註過長" }, 400);
    if (!Number.isFinite(pickup.getTime()) || pickup.getTime() <= Date.now() + 10 * 60_000 || pickup.getTime() > Date.now() + 14 * 24 * 60 * 60_000 || !isAllowedPickupTime(pickup)) {
      return reply({ ok: false, error: "希望取餐時間需在 10 分鐘後、未來 14 天內，且限 17:30 至隔日凌晨 02:00（每 5 分鐘一個時段）" }, 400);
    }
    if (!Array.isArray(input) || input.length < 1 || input.length > 40) return reply({ ok: false, error: "餐點內容不正確" }, 400);

    const quantities = new Map<string, number>();
    const variantByKey = new Map<string, { productId: string; spice: string | null }>();
    const giftQuantities = new Map<string, number>();
    for (const item of input) {
      const id = String(item?.product_id ?? "").trim();
      const qty = Number(item?.quantity);
      const spice = item?.spice_level == null ? null : String(item.spice_level);
      if (!id || !Number.isInteger(qty) || qty < 1 || qty > 30) return reply({ ok: false, error: "餐點數量不正確" }, 400);
      if (spice !== null && !["不辣", "小辣", "中辣", "大辣"].includes(spice)) return reply({ ok: false, error: "辣度選項不正確" }, 400);
      const key = `${id}::${spice ?? "__none__"}`;
      quantities.set(key, (quantities.get(key) ?? 0) + qty);
      variantByKey.set(key, { productId: id, spice });
    }
    if ([...quantities.values()].some(q => q > 30)) return reply({ ok: false, error: "同一餐點、同一辣度的數量超過限制" }, 400);

    const freeDrinkInput = Array.isArray(body.free_drinks) ? body.free_drinks : [];
    if (freeDrinkInput.length > 20) return reply({ ok: false, error: "贈品飲料選擇過多" }, 400);
    for (const item of freeDrinkInput) {
      const id = String(item?.product_id ?? "").trim();
      const qty = Number(item?.quantity);
      if (!id || !Number.isInteger(qty) || qty < 1 || qty > 20) return reply({ ok: false, error: "贈品飲料數量不正確" }, 400);
      giftQuantities.set(id, (giftQuantities.get(id) ?? 0) + qty);
    }
    if ([...giftQuantities.values()].some(q => q > 20)) return reply({ ok: false, error: "單項贈品飲料數量超過限制" }, 400);

    const ids = [...new Set([...variantByKey.values()].map(v => v.productId).concat([...giftQuantities.keys()]))];
    const [{ data: products, error: readError }, { data: settingsRow, error: settingsError }] = await Promise.all([
      admin.from("products").select("id,name,price").in("id", ids),
      admin.from("menu_generator_settings").select("settings_json").eq("id", "default").maybeSingle(),
    ]);
    if (readError) throw readError;
    if (settingsError) throw settingsError;
    if (!products || products.length !== ids.length) return reply({ ok: false, error: "部分餐點已下架，請重新整理菜單" }, 400);

    const allSettings = settingsRow?.settings_json ?? {};
    const spicySettings = allSettings.customerOrderSpicySettings ?? {};
    const menuItemSettings = allSettings.menuItemSettings ?? {};
    const soldOutIds = allSettings.customerOrderSoldOutDate === taiwanDateValue(new Date())
      ? new Set((allSettings.customerOrderSoldOutProductIds ?? []).map(String)) : new Set<string>();
    const explicitGiftIds = Array.isArray(allSettings.customerOrderGiftDrinkProductIds)
      ? new Set(allSettings.customerOrderGiftDrinkProductIds.map(String)) : null;
    const productMap = new Map(products.map((p: any) => [String(p.id), p]));
    for (const id of ids) {
      if (soldOutIds.has(id)) return reply({ ok: false, error: `「${String((productMap.get(id) as any)?.name ?? "餐點")}」今日已售完，請移除後重新送出` }, 409);
    }

    const snapshot: any[] = [...quantities.keys()].map(key => {
      const variant = variantByKey.get(key)!;
      const id = variant.productId;
      const p: any = productMap.get(id);
      const price = Number(p?.price), quantity = quantities.get(key)!;
      if (!p || !Number.isFinite(price) || price < 0) throw new Error("商品價格資料異常");
      const spice = variant.spice;
      const config = spicySettings[id] ?? {};
      const spicyEnabled = config.enabled !== false;
      const allowedLevels = Array.isArray(config.levels) && config.levels.length ? config.levels : ["不辣", "小辣", "中辣", "大辣"];
      if (spicyEnabled && (!spice || !allowedLevels.includes(spice))) {
        throw new Error(`「${String(p.name)}」請選擇有效辣度，或重新載入菜單`);
      }
      if (!spicyEnabled && spice) {
        throw new Error(`「${String(p.name)}」目前未開放辣度選擇，請重新載入菜單`);
      }
      return {
        product_id: id, name: String(p.name ?? "商品").slice(0, 100), unit_price: price,
        quantity, subtotal: Math.round(price * quantity * 100) / 100,
        ...(spice ? { spice_level: spice } : {}),
      };
    });
    const total = Math.round(snapshot.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
    const giftLimit = Math.floor(total / 400);
    const selectedGiftCount = [...giftQuantities.values()].reduce((sum, qty) => sum + qty, 0);
    const configuredGiftIds = explicitGiftIds
      ? [...explicitGiftIds]
      : Object.keys(menuItemSettings).filter((id) => menuItemSettings[id]?.category === "飲品類");
    let availableGiftIds: string[] = [];
    if (configuredGiftIds.length) {
      const { data: giftCatalog, error: giftCatalogError } = await admin.from("products")
        .select("id").in("id", configuredGiftIds);
      if (giftCatalogError) throw giftCatalogError;
      availableGiftIds = (giftCatalog ?? []).map((p: any) => String(p.id));
    }
    const hasAvailableGift = availableGiftIds.some((id) => !soldOutIds.has(String(id)));
    if (selectedGiftCount > giftLimit) return reply({ ok: false, error: `此訂單最多可選 ${giftLimit} 杯滿額贈飲料` }, 400);
    if (giftLimit > 0 && hasAvailableGift && selectedGiftCount !== giftLimit) {
      return reply({ ok: false, error: `此訂單可選 ${giftLimit} 杯滿額贈飲料，請選滿贈品數量` }, 400);
    }
    for (const [id, quantity] of giftQuantities) {
      const p: any = productMap.get(id);
      const isDrink = menuItemSettings[id]?.category === "飲品類";
      if (!p || !isDrink || (explicitGiftIds && !explicitGiftIds.has(id))) {
        return reply({ ok: false, error: "所選贈品飲料已不在店家提供的品項中，請重新選擇" }, 400);
      }
      snapshot.push({ product_id: id, name: String(p.name ?? "贈品飲料").slice(0, 100), unit_price: 0, quantity, subtotal: 0, is_gift: true });
    }
    const { data: orderRows, error: insertError } = await admin.rpc("create_customer_order_atomic", {
      p_customer_name: name, p_customer_phone: phone, p_pickup_time: pickup.toISOString(),
      p_items: snapshot, p_total_amount: total, p_note: note,
    });
    if (insertError) {
      if (insertError.code === "23505") return reply({ ok: false, error: insertError.message || "此手機號碼已有尚未完成的訂單，請使用加點功能" }, 409);
      throw insertError;
    }
    const order = Array.isArray(orderRows) ? orderRows[0] : orderRows;
    const notificationTask = notifyOwner(admin, "馬鈴吉碳烤｜新訂單", `收到新訂單（${name}／${phone}），金額 $${total.toLocaleString("zh-TW")}，請開啟訂單管理查看。`);
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(notificationTask);
    else await notificationTask;
    return reply({ ok: true, id: order.id, order_number: String(order.id).slice(0, 8), total_amount: total });
  } catch (error) {
    console.error("customer-orders error", error);
    const message = error instanceof Error ? error.message : "訂單處理失敗，請稍後再試";
    const details = error && typeof error === "object" && "code" in error ? String((error as any).code) : undefined;
    console.error("[customer-orders][diagnostic]", { message, code: details });
    return reply({ ok: false, error: message, code: details }, 500);
  }
});

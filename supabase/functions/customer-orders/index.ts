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

    if (action === "health") return reply({ ok: true, function: "customer-orders", version: "phone-history-card-picker-20261120" });

    // 以客人下單時提供的手機號碼查詢訂單歷史。
    if (action === "lookup-orders") {
      const phone = String(body.customer_phone ?? "").replace(/\D/g, "").replace(/^886(?=9\d{8}$)/, "0");
      if (!/^09\d{8}$/.test(phone)) return reply({ ok: false, error: "手機號碼格式不正確" }, 400);
      const { data: orders, error } = await admin.from("customer_orders")
        .select("id,items,total_amount,status,pickup_time,created_at")
        .eq("customer_phone", phone).order("created_at", { ascending: false }).limit(50);
      if (error) throw error;
      return reply({ ok: true, orders: orders ?? [] });
    }

    // 客人查詢自己的訂單狀態：只回傳狀態與取餐時間，不回傳個資。
    if (action === "get-order") {
      const id = String(body.order_id ?? "").trim();
      if (!id) return reply({ ok: false, error: "訂單編號不正確" }, 400);
      const { data: order, error } = await admin.from("customer_orders")
        .select("id,status,pickup_time,note").eq("id", id).maybeSingle();
      if (error) throw error;
      if (!order) return reply({ ok: false, error: "找不到訂單" }, 404);
      const { meta } = readNote(String(order.note ?? ""));
      return reply({ ok: true, status: order.status, pickup_time: order.pickup_time,
        proposed_pickup_time: typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : null,
        customer_response: typeof meta.customer_response === "string" ? meta.customer_response : null });
    }

    // 客人回覆店家提出的時間；同意才正式寫入 pickup_time 並確認訂單。
    if (action === "respond-time") {
      const id = String(body.order_id ?? "").trim();
      if (!id || typeof body.accepted !== "boolean") return reply({ ok: false, error: "回覆資料不正確" }, 400);
      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,status,pickup_time,note").eq("id", id).maybeSingle();
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
      if (!id || !Number.isFinite(proposed.getTime()) || proposed.getTime() < Date.now() + 10 * 60_000) {
        return reply({ ok: false, error: "請選擇至少 10 分鐘後的可取餐時間" }, 400);
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
    if (!Number.isFinite(pickup.getTime()) || pickup.getTime() < Date.now() + 10 * 60_000 || pickup.getTime() > Date.now() + 14 * 24 * 60 * 60_000) {
      return reply({ ok: false, error: "希望取餐時間不在允許範圍" }, 400);
    }
    if (!Array.isArray(input) || input.length < 1 || input.length > 40) return reply({ ok: false, error: "餐點內容不正確" }, 400);

    const quantities = new Map<string, number>();
    const spiceById = new Map<string, string | null>();
    for (const item of input) {
      const id = String(item?.product_id ?? "").trim();
      const qty = Number(item?.quantity);
      if (!id || !Number.isInteger(qty) || qty < 1 || qty > 30) return reply({ ok: false, error: "餐點數量不正確" }, 400);
      quantities.set(id, (quantities.get(id) ?? 0) + qty);
      spiceById.set(id, item?.spice_level == null ? null : String(item.spice_level));
    }
    if ([...quantities.values()].some(q => q > 30)) return reply({ ok: false, error: "單項餐點數量超過限制" }, 400);

    const ids = [...quantities.keys()];
    const [{ data: products, error: readError }, { data: settingsRow, error: settingsError }] = await Promise.all([
      admin.from("products").select("id,name,price").in("id", ids),
      admin.from("menu_generator_settings").select("settings_json").eq("id", "default").maybeSingle(),
    ]);
    if (readError) throw readError;
    if (settingsError) throw settingsError;
    if (!products || products.length !== ids.length) return reply({ ok: false, error: "部分餐點已下架，請重新整理菜單" }, 400);
    const spicySettings = settingsRow?.settings_json?.customerOrderSpicySettings ?? {};
    const productMap = new Map(products.map((p: any) => [String(p.id), p]));
    const snapshot = ids.map(id => {
      const p: any = productMap.get(id);
      const price = Number(p?.price), quantity = quantities.get(id)!;
      if (!p || !Number.isFinite(price) || price < 0) throw new Error("商品價格資料異常");
      const spice = spiceById.get(id);
      const config = spicySettings[id];
      if (spice !== null && spice !== undefined && (!config?.enabled || !Array.isArray(config.levels) || !config.levels.includes(spice))) {
        throw new Error(`「${String(p.name)}」辣度選項已變更，請重新載入菜單`);
      }
      return {
        product_id: id, name: String(p.name ?? "商品").slice(0, 100), unit_price: price,
        quantity, subtotal: Math.round(price * quantity * 100) / 100,
        ...(spice ? { spice_level: spice } : {}),
      };
    });
    const total = Math.round(snapshot.reduce((sum, item) => sum + item.subtotal, 0) * 100) / 100;
    const { data: order, error: insertError } = await admin.from("customer_orders").insert({
      customer_name: name, customer_phone: phone, pickup_time: pickup.toISOString(),
      items: snapshot, total_amount: total, note, status: "new",
    }).select("id,created_at").single();
    if (insertError) throw insertError;

    const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
    const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
    const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:store@example.com";
    if (vapidPublic && vapidPrivate) {
      try {
        webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
        const { data: subs, error: subsError } = await admin.from("customer_push_subscriptions").select("id,endpoint,p256dh,auth");
        if (subsError) throw subsError;
        const payload = JSON.stringify({ title: "馬鈴吉碳烤｜新訂單", body: `收到新訂單（${name}），金額 $${total.toLocaleString("zh-TW")}，請開啟訂單管理查看。`, url: "/" });
        for (const sub of subs ?? []) {
          try {
            await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
          } catch (e: any) {
            if (e?.statusCode === 404 || e?.statusCode === 410) await admin.from("customer_push_subscriptions").delete().eq("id", sub.id);
            console.warn("[customer-orders][push] send failed", e?.statusCode ?? "unknown");
          }
        }
      } catch (e) { console.warn("[customer-orders][push] delivery skipped; order remains saved", e); }
    }
    return reply({ ok: true, id: order.id, order_number: String(order.id).slice(0, 8), total_amount: total });
  } catch (error) {
    console.error("customer-orders error", error);
    const message = error instanceof Error ? error.message : "訂單處理失敗，請稍後再試";
    const details = error && typeof error === "object" && "code" in error ? String((error as any).code) : undefined;
    console.error("[customer-orders][diagnostic]", { message, code: details });
    return reply({ ok: false, error: message, code: details }, 500);
  }
});

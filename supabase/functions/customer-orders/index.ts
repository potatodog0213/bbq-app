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

function orderDisplayLabel(order: { created_at?: string; customer_name?: string; daily_sequence?: number | null }) {
  const date = order.created_at ? new Date(order.created_at) : new Date();
  const dateText = taiwanDateValue(date).replaceAll("-", "");
  const name = String(order.customer_name ?? "顧客").trim().slice(0, 20);
  const sequence = Number(order.daily_sequence);
  return `訂單｜${dateText}｜${name}${Number.isInteger(sequence) && sequence > 0 ? `｜#${String(sequence).padStart(3, "0")}` : ""}`;
}


function normalizePhone(value: unknown) {
  return String(value ?? "").replace(/\D/g, "").replace(/^886(?=9\d{8}$)/, "0");
}
async function sha256Hex(value: string) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hashRateLimitIdentifier(value: string) {
  // 使用只有 Edge Function 可讀取的服務端 key 作為 pepper，避免限流表中的電話雜湊可被離線枚舉。
  const pepper = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return sha256Hex(`${pepper}:${value}`);
}
async function consumeOrderRateLimit(admin: ReturnType<typeof createClient>, key: string, limit: number, windowSeconds: number) {
  const { data, error } = await admin.rpc("consume_customer_order_rate_limit", {
    p_key: key, p_limit: limit, p_window_seconds: windowSeconds,
  });
  if (error) {
    console.error("[customer-orders][rate-limit] storage unavailable", error.message);
    throw new Error("訂單安全防護暫時無法使用，請稍後再試");
  }
  const row = Array.isArray(data) ? data[0] : data;
  return row?.allowed === true;
}
async function enforcePublicOrderRateLimits(admin: ReturnType<typeof createClient>, req: Request, action: string, body: any) {
  // 優先使用由 Supabase/Cloudflare gateway 提供的來源 IP header，不採用可由客戶端自行偽造的 X-Forwarded-For。
  const sourceIp = req.headers.get("cf-connecting-ip") || req.headers.get("x-real-ip") || "unknown";
  const ipHash = await hashRateLimitIdentifier(sourceIp.slice(0, 128));
  const phone = normalizePhone(body?.customer_phone);
  const checks: Array<{ key: string; limit: number; seconds: number }> = [
    { key: `ip:${ipHash}:public`, limit: 240, seconds: 600 },
  ];
  if (action === "create-order") {
    checks.push({ key: `ip:${ipHash}:create`, limit: 8, seconds: 600 });
    if (/^09\d{8}$/.test(phone)) checks.push({ key: `phone:${await hashRateLimitIdentifier(phone)}:create`, limit: 3, seconds: 600 });
  } else if (action === "lookup-orders") {
    checks.push({ key: `ip:${ipHash}:lookup`, limit: 160, seconds: 600 });
    if (/^09\d{8}$/.test(phone)) checks.push({ key: `phone:${await hashRateLimitIdentifier(phone)}:lookup`, limit: 150, seconds: 600 });
  } else if (["direct-edit-order", "request-cancel-order", "request-order-change", "get-order", "respond-time", "issue-order-change-token", "submit-order-change", "line-order-status"].includes(action)) {
    checks.push({ key: `ip:${ipHash}:order-action`, limit: 20, seconds: 600 });
    if (/^09\d{8}$/.test(phone)) checks.push({ key: `phone:${await hashRateLimitIdentifier(phone)}:order-action`, limit: 8, seconds: 600 });
  }
  for (const check of checks) {
    if (!await consumeOrderRateLimit(admin, check.key, check.limit, check.seconds)) return false;
  }
  return true;
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
function lineAuthError(message: string) {
  const error = new Error(message);
  (error as any).status = 401;
  return error;
}
async function verifyLineIdentity(accessToken: unknown) {
  const token = String(accessToken ?? "").trim();
  const channelId = Deno.env.get("LINE_LOGIN_CHANNEL_ID") ?? "";
  if (!token || !channelId) throw lineAuthError("尚未完成 LINE 登入設定，請稍後再試");
  let verifyResponse: Response;
  try {
    verifyResponse = await fetch(`https://api.line.me/oauth2/v2.1/verify?access_token=${encodeURIComponent(token)}`);
  } catch {
    throw new Error("LINE 驗證服務暫時無法連線，請稍後再試");
  }
  if (!verifyResponse.ok) throw lineAuthError("LINE 登入驗證失敗，請重新綁定 LINE");
  const verified = await verifyResponse.json();
  if (String(verified.client_id ?? "") !== channelId || Number(verified.expires_in ?? 0) <= 0) throw lineAuthError("LINE 登入身分無效，請重新綁定 LINE");
  const profileResponse = await fetch("https://api.line.me/v2/profile", { headers: { Authorization: `Bearer ${token}` } });
  if (!profileResponse.ok) throw lineAuthError("無法取得 LINE 使用者資料，請重新綁定 LINE");
  const profile = await profileResponse.json();
  if (typeof profile.userId !== "string" || !/^U[0-9a-fA-F]{32}$/.test(profile.userId)) throw lineAuthError("LINE 使用者資料不正確");
  return { userId: profile.userId, displayName: String(profile.displayName ?? "LINE 顧客").slice(0, 100) };
}
async function sendLineOrderLink(userId: string, displayName: string, orderLabel: string, statusUrl: string) {
  const accessToken = Deno.env.get("LINE_CHANNEL_ACCESS_TOKEN") ?? "";
  if (!accessToken) return false;
  const response = await fetch("https://api.line.me/v2/bot/message/push", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ to: userId, messages: [{
      type: "template", altText: "馬鈴吉碳烤訂單已成立，點擊查詢訂單進度",
      template: { type: "buttons", title: "訂單已成立", text: `${displayName}，${orderLabel} 已收到！可點擊下方按鈕查看這筆訂單的目前進度。`,
        actions: [{ type: "uri", label: "查詢訂單進度", uri: statusUrl }] },
    }] }),
  });
  if (!response.ok) { console.warn("[customer-orders][LINE] push failed", response.status, (await response.text()).slice(0, 300)); return false; }
  return true;
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
async function buildGiftDrinkSnapshot(admin: ReturnType<typeof createClient>, input: unknown, regularTotal: number) {
  const rows = Array.isArray(input) ? input : [];
  if (rows.length > 20) throw new Error("贈品飲料選擇過多");
  const quantities = new Map<string, number>();
  for (const row of rows) {
    const id = String(row?.product_id ?? "").trim();
    const quantity = Number(row?.quantity);
    if (!/^\d+$/.test(id) || !Number.isInteger(quantity) || quantity < 1 || quantity > 20) throw new Error("贈品飲料數量不正確");
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }
  if ([...quantities.values()].some((quantity) => quantity > 20)) throw new Error("單項贈品飲料數量超過限制");
  const [{ data: settingsRow, error: settingsError }] = await Promise.all([
    admin.from("menu_generator_settings").select("settings_json").eq("id", "default").maybeSingle(),
  ]);
  if (settingsError) throw settingsError;
  const settings = settingsRow?.settings_json ?? {};
  const menu = settings.menuItemSettings ?? {};
  const configured = Array.isArray(settings.customerOrderGiftDrinkProductIds)
    ? settings.customerOrderGiftDrinkProductIds.map(String)
    : Object.keys(menu).filter((id) => menu[id]?.category === "飲品類");
  const soldOut = settings.customerOrderSoldOutDate === taiwanDateValue(new Date())
    ? new Set((settings.customerOrderSoldOutProductIds ?? []).map(String)) : new Set<string>();
  let availableCatalogIds: string[] = [];
  if (configured.length) {
    const { data: giftCatalog, error: giftCatalogError } = await admin.from("products").select("id").in("id", configured);
    if (giftCatalogError) throw giftCatalogError;
    availableCatalogIds = (giftCatalog ?? []).map((product: any) => String(product.id));
  }
  const availableIds = availableCatalogIds.filter((id) => !soldOut.has(id));
  const giftLimit = Math.floor(regularTotal / 400);
  const selectedCount = [...quantities.values()].reduce((sum, quantity) => sum + quantity, 0);
  if (selectedCount > giftLimit) throw new Error(`此訂單最多可選 ${giftLimit} 杯滿額贈飲料`);
  if (giftLimit > 0 && availableIds.length && selectedCount > 0 && selectedCount !== giftLimit) throw new Error(`此訂單可選 ${giftLimit} 杯滿額贈飲料，請選滿贈品數量或不領取`);
  if (!quantities.size) return [];
  const ids = [...quantities.keys()];
  if (ids.some((id) => !availableIds.includes(id))) throw new Error("所選贈品飲料不在目前可贈送清單或已售完");
  const { data: products, error: productError } = await admin.from("products").select("id,name").in("id", ids);
  if (productError) throw productError;
  if (!products || products.length !== ids.length) throw new Error("部分贈品飲料已下架，請重新選擇");
  return products.map((product: any) => ({ product_id: String(product.id), name: String(product.name ?? "贈品飲料").slice(0, 100), unit_price: 0, quantity: quantities.get(String(product.id)) ?? 0, subtotal: 0, is_gift: true }));
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
    const isDrink = settings.menuItemSettings?.[variant.productId]?.category === "飲品類";
    const spicyEnabled = !isDrink && config.enabled !== false;
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

function base64UrlEncode(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
function base64UrlDecode(value: string) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized + "=".repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}
async function lookupTokenKey() {
  const secret = Deno.env.get("CUSTOMER_LOOKUP_TOKEN_SECRET") || Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!secret) throw new Error("Lookup token signing key is not configured");
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
async function issueCustomerLookupToken(phone: string) {
  const expiresAt = Date.now() + 12 * 60 * 60_000;
  const payload = new TextEncoder().encode(`customer-order-lookup:${phone}:${expiresAt}`);
  const signature = await crypto.subtle.sign("HMAC", await lookupTokenKey(), payload);
  return `${expiresAt}.${base64UrlEncode(new Uint8Array(signature))}`;
}
async function verifyCustomerLookupToken(token: unknown, phone: string) {
  const [expiryText, signatureText, extra] = String(token ?? "").split(".");
  const expiresAt = Number(expiryText);
  if (extra || !Number.isSafeInteger(expiresAt) || expiresAt <= Date.now() || expiresAt > Date.now() + 12 * 60 * 60_000) return false;
  try {
    const payload = new TextEncoder().encode(`customer-order-lookup:${phone}:${expiresAt}`);
    return await crypto.subtle.verify("HMAC", await lookupTokenKey(), base64UrlDecode(signatureText || ""), payload);
  } catch { return false; }
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

    const publicRateLimitedActions = ["create-order", "lookup-orders", "line-order-status", "get-order", "respond-time", "direct-edit-order", "request-cancel-order", "request-order-change", "issue-order-change-token", "submit-order-change"];
    if (publicRateLimitedActions.includes(action)) {
      const allowed = await enforcePublicOrderRateLimits(admin, req, action, body);
      if (!allowed) return reply({ ok: false, error: "操作太頻繁，請稍後再試。為保護訂單與電話資料，系統已暫時限制此請求。" }, 429);
    }

    if (action === "send-pickup-reminders") {
      const expected = Deno.env.get("CUSTOMER_ORDER_REMINDER_SECRET");
      const supplied = req.headers.get("x-cron-secret") ?? "";
      if (!expected || supplied !== expected) return reply({ ok: false, error: "Unauthorized reminder job" }, 403);
      if (!Deno.env.get("VAPID_PUBLIC_KEY") || !Deno.env.get("VAPID_PRIVATE_KEY")) return reply({ ok: false, error: "尚未設定 Web Push VAPID 金鑰" }, 503);
      const { count: subscriptionCount, error: subscriptionError } = await admin.from("customer_push_subscriptions").select("id", { count: "exact", head: true });
      if (subscriptionError) throw subscriptionError;
      if (!subscriptionCount) return reply({ ok: false, error: "尚未有店家手機啟用訂單推播" }, 409);
      const now = Date.now();
      const from = new Date(now + 9 * 60_000).toISOString();
      const to = new Date(now + 10 * 60_000).toISOString();
      const { data: due, error: dueError } = await admin.from("customer_orders")
        .select("id,customer_name,customer_phone,pickup_time,created_at,items,status,pickup_reminder_sent_at,daily_sequence")
        .in("status", ["new", "confirmed", "preparing"]).gte("pickup_time", from).lte("pickup_time", to)
        .is("pickup_reminder_sent_at", null).limit(100);
      if (dueError) throw dueError;
      let sent = 0;
      for (const order of due ?? []) {
        const { data: claimed, error: claimError } = await admin.from("customer_orders")
          .update({ pickup_reminder_sent_at: new Date().toISOString() }).eq("id", order.id).is("pickup_reminder_sent_at", null).select("id").maybeSingle();
        if (claimError) throw claimError;
        if (!claimed) continue;
        const pickupLabel = new Date(order.pickup_time).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
        const orderLabel = orderDisplayLabel(order);
        const count = (Array.isArray(order.items) ? order.items : []).reduce((n: number, item: any) => n + (Number(item.quantity) || 0), 0);
        await notifyOwner(admin, "馬鈴吉碳烤｜取餐前 10 分鐘提醒", `${orderLabel}，取餐時間 ${pickupLabel}，共 ${count} 件餐點。請準備製作／出餐。`);
        sent++;
      }
      return reply({ ok: true, checked: due?.length ?? 0, sent });
    }

    if (action === "health") return reply({ ok: true, function: "customer-orders", version: "customer-order-line-identity-20261122" });

    if (action === "lookup-orders") {
      return reply({ ok: false, error: "已改用 LINE 訂單專屬連結查詢，請從官方 LINE 訊息中的「查詢訂單進度」按鈕開啟。" }, 410);
    }

    if (action === "line-order-status") {
      const orderId = String(body.order_id ?? "").trim();
      const statusToken = String(body.status_token ?? "").trim();
      if (!orderId || !/^[a-f0-9]{64}$/i.test(statusToken)) return reply({ ok: false, error: "訂單查詢連結無效" }, 400);
      const line = await verifyLineIdentity(body.line_access_token);
      const tokenHash = await sha256Hex(statusToken);
      const { data: order, error } = await admin.from("customer_orders")
        .select("id,line_user_id,status,status_token_hash,pickup_time,daily_sequence,note")
        .eq("id", orderId).eq("line_user_id", line.userId).eq("status_token_hash", tokenHash).maybeSingle();
      if (error) throw error;
      if (!order) return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的查詢權限" }, 403);
      const { meta } = readNote(String(order.note ?? ""));
      return reply({
        ok: true,
        status: order.status,
        pickup_time: order.pickup_time,
        proposed_pickup_time: typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : null,
        customer_response: typeof meta.customer_response === "string" ? meta.customer_response : null,
        needs_reschedule: meta.needs_reschedule === true,
        order_number: order.daily_sequence ? `#${String(order.daily_sequence).padStart(3, "0")}` : String(order.id).slice(0, 8)
      });
    }

    if (action === "get-order") {
      return reply({ ok: false, error: "已改用 LINE 帳號與單筆訂單專屬連結查詢，不再接受手機號碼查詢。" }, 410);
    }

    if (action === "respond-time") {
      const id = String(body.order_id ?? "").trim();
      if (!id || typeof body.accepted !== "boolean") return reply({ ok: false, error: "回覆資料不正確" }, 400);
      const line = await verifyLineIdentity(body.line_access_token);
      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,line_user_id,status,pickup_time,note,created_at,customer_name,daily_sequence,confirmed_at,preparing_at,completed_at,cancelled_at")
        .eq("id", id).eq("line_user_id", line.userId).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的操作權限" }, 403);
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      const proposed = typeof meta.proposed_pickup_time === "string" ? meta.proposed_pickup_time : "";
      if (!proposed) return reply({ ok: false, error: "目前沒有待確認的取餐時間" }, 409);
      if (body.accepted) {
        const { error } = await admin.from("customer_orders").update({
          pickup_time: proposed, status: "confirmed", confirmed_at: new Date().toISOString(),
          note: writeNote(customerNote, { ...meta, proposed_pickup_time: null, customer_response: "accepted" }),
        }).eq("id", id).eq("line_user_id", line.userId);
        if (error) throw error;
        const label = orderDisplayLabel(order);
        const task = notifyOwner(admin, "馬鈴吉碳烤｜客人接受新取餐時間", `${label}（LINE：${line.displayName}）已接受店家提出的時間：${new Date(proposed).toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false })}。訂單已確認。`);
        const runtime = (globalThis as any).EdgeRuntime;
        if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
        return reply({ ok: true, status: "confirmed", pickup_time: proposed });
      }
      const { error } = await admin.from("customer_orders").update({
        note: writeNote(customerNote, { ...meta, proposed_pickup_time: null, customer_response: "declined", needs_reschedule: true }),
      }).eq("id", id).eq("line_user_id", line.userId);
      if (error) throw error;
      const label = orderDisplayLabel(order);
      const task = notifyOwner(admin, "馬鈴吉碳烤｜客人無法配合取餐時間", `${label}（LINE：${line.displayName}）表示店家提出的時間不方便，請重新安排取餐時間並再次通知客人。`);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
      return reply({ ok: true, status: order.status, customer_response: "declined", needs_reschedule: true });
    }

    // 客人直接修改原訂單餐點，不再建立申請或要求填寫原因。
    if (action === "direct-edit-order") {
      const orderId = String(body.order_id ?? "").trim();
      if (!orderId) return reply({ ok: false, error: "訂單修改資料不正確" }, 400);
      const line = await verifyLineIdentity(body.line_access_token);
      const { snapshot, total } = await buildRegularItemSnapshot(admin, body.items);
      const giftSnapshot = await buildGiftDrinkSnapshot(admin, body.free_drinks, total);
      const { data: currentOrder, error: currentError } = await admin.from("customer_orders")
        .select("id,line_user_id,customer_name,status,pickup_time,created_at,daily_sequence")
        .eq("id", orderId).eq("line_user_id", line.userId).maybeSingle();
      if (currentError) throw currentError;
      if (!currentOrder) return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的修改權限" }, 403);
      if (new Date(currentOrder.pickup_time).getTime() <= Date.now() + 15 * 60_000) {
        return reply({ ok: false, error: "距離預定取餐時間不足 15 分鐘，已無法修改餐點" }, 409);
      }
      const { data, error } = await admin.rpc("edit_customer_order_direct_atomic", {
        p_order_id: orderId, p_customer_phone: line.userId, p_new_items: [...snapshot, ...giftSnapshot], p_new_base_total: total,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的修改權限" }, 403);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const result = Array.isArray(data) ? data[0] : data;
      const editedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
      const orderLabel = orderDisplayLabel(currentOrder);
      const task = notifyOwner(admin, "馬鈴吉碳烤｜客人修改訂單", `${orderLabel}（LINE：${line.displayName}）於 ${editedAt} 修改餐點，請至訂單管理查看最新內容。`);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
      return reply({ ok: true, total_amount: result?.new_total });
    }

    if (action === "request-cancel-order") {
      const id = String(body.order_id ?? "").trim();
      if (!id) return reply({ ok: false, error: "取消申請資料不正確" }, 400);
      const line = await verifyLineIdentity(body.line_access_token);
      const { data: order, error: readError } = await admin.from("customer_orders")
        .select("id,line_user_id,customer_name,status,pickup_time,created_at,note,daily_sequence")
        .eq("id", id).eq("line_user_id", line.userId).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的取消權限" }, 403);
      if (!["new", "confirmed", "preparing"].includes(String(order.status))) return reply({ ok: false, error: "此訂單目前無法申請取消" }, 409);
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      if (typeof meta.cancel_requested_at === "string") return reply({ ok: true, already_requested: true });
      const requestedAt = new Date().toISOString();
      const { error } = await admin.from("customer_orders").update({
        note: writeNote(customerNote, { ...meta, cancel_requested_at: requestedAt })
      }).eq("id", id).eq("line_user_id", line.userId);
      if (error) throw error;
      const label = orderDisplayLabel(order);
      const task = notifyOwner(admin, "馬鈴吉碳烤｜客人申請取消訂單", `${label}（LINE：${line.displayName}）提出取消申請，請至訂單管理處理。`);
      const runtime = (globalThis as any).EdgeRuntime;
      if (runtime?.waitUntil) runtime.waitUntil(task); else await task;
      return reply({ ok: true });
    }

    if (action === "owner-review-cancel-request") {
      const user = await ownerUser(req, url, anonKey);
      if (!user) return reply({ ok: false, error: "未授權的店家帳號" }, 403);
      const id = String(body.order_id ?? "").trim();
      const accepted = body.accepted === true;
      if (!id || typeof body.accepted !== "boolean") return reply({ ok: false, error: "取消申請審核資料不正確" }, 400);
      const { data: order, error: readError } = await admin.from("customer_orders").select("id,status,note").eq("id", id).maybeSingle();
      if (readError) throw readError;
      if (!order) return reply({ ok: false, error: "找不到訂單" }, 404);
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      if (typeof meta.cancel_requested_at !== "string") return reply({ ok: false, error: "此訂單沒有待處理的取消申請" }, 409);
      const nextMeta = { ...meta, cancel_requested_at: null, cancel_request_reviewed_at: new Date().toISOString(), cancel_request_result: accepted ? "accepted" : "declined" };
      const update: Record<string, unknown> = { note: writeNote(customerNote, nextMeta) };
      if (accepted) { if (!["new", "confirmed", "preparing"].includes(String(order.status))) return reply({ ok: false, error: "訂單狀態已變更，無法取消" }, 409); update.status = "cancelled"; update.cancelled_at = new Date().toISOString(); }
      const { error } = await admin.from("customer_orders").update(update).eq("id", id).eq("status", order.status);
      if (error) throw error;
      return reply({ ok: true, status: accepted ? "cancelled" : order.status });
    }

    if (action === "request-order-change") {
      const orderId = String(body.order_id ?? "").trim();
      const proposal = String(body.proposal_text ?? "").trim();
      const reason = String(body.reason ?? "").trim();
      if (!orderId || !proposal || proposal.length > 500 || !reason || reason.length > 300) {
        return reply({ ok: false, error: "請填寫修改內容與原因（修改內容最多 500 字、原因最多 300 字）" }, 400);
      }
      const line = await verifyLineIdentity(body.line_access_token);
      const { data: requestId, error } = await admin.rpc("create_customer_order_change_request_atomic", {
        p_order_id: orderId, p_customer_phone: line.userId, p_proposal_text: proposal, p_reason: reason,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的修改權限" }, 403);
        if (error.code === "23505") return reply({ ok: false, error: "此訂單已有待審核的修改申請" }, 409);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      const requestedAt = new Date().toLocaleString("zh-TW", { timeZone: "Asia/Taipei", hour12: false });
      const { data: requestedOrder, error: requestedOrderError } = await admin.from("customer_orders").select("id,customer_name,created_at,daily_sequence").eq("id", orderId).eq("line_user_id", line.userId).maybeSingle();
      if (requestedOrderError) throw requestedOrderError;
      const label = requestedOrder ? orderDisplayLabel(requestedOrder) : `訂單 ${orderId.slice(0, 8)}`;
      const task = notifyOwner(admin, "馬鈴吉碳烤｜訂單修改申請", `${label}（LINE：${line.displayName}）於 ${requestedAt} 提出修改申請：${proposal}；原因：${reason}。請至訂單管理審核。`);
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

      const timestampColumn: Record<string, string> = { confirmed: "confirmed_at", preparing: "preparing_at", completed: "completed_at", cancelled: "cancelled_at" };
      const { data: updated, error: updateError } = await admin.from("customer_orders")
        .update({ status: nextStatus, [timestampColumn[nextStatus]]: new Date().toISOString() }).eq("id", orderId).eq("status", currentStatus)
        .select("id,status").maybeSingle();
      if (updateError) throw updateError;
      if (!updated) return reply({ ok: false, error: "訂單狀態已被其他操作更新，請重新整理後再試" }, 409);
      return reply({ ok: true, order_id: updated.id, status: updated.status });
    }

    if (action === "issue-order-change-token") {
      const requestId = String(body.request_id ?? "").trim();
      if (!requestId) return reply({ ok: false, error: "修改授權資料不正確" }, 400);
      const line = await verifyLineIdentity(body.line_access_token);
      const token = randomCapabilityToken();
      const tokenHash = await sha256Hex(token);
      const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
      const { error } = await admin.rpc("issue_customer_order_change_token_atomic", {
        p_request_id: requestId, p_customer_phone: line.userId,
        p_capability_hash: tokenHash, p_expires_at: expiresAt,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "此 LINE 帳號沒有這筆修改申請的授權權限" }, 403);
        if (error.code === "55000") return reply({ ok: false, error: error.message }, 409);
        throw error;
      }
      return reply({ ok: true, capability_token: token, expires_at: expiresAt });
    }

    if (action === "submit-order-change") {
      const orderId = String(body.order_id ?? "").trim();
      const token = String(body.capability_token ?? "").trim();
      if (!orderId || !/^[0-9a-f]{64}$/i.test(token)) {
        return reply({ ok: false, error: "修改資料或授權碼不正確" }, 400);
      }
      const line = await verifyLineIdentity(body.line_access_token);
      const { snapshot, total } = await buildRegularItemSnapshot(admin, body.items);
      const { data: currentOrder, error: currentOrderError } = await admin.from("customer_orders")
        .select("items,note,line_user_id").eq("id", orderId).eq("line_user_id", line.userId).maybeSingle();
      if (currentOrderError) throw currentOrderError;
      if (!currentOrder) return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的修改權限" }, 403);
      const giftItems = (Array.isArray(currentOrder.items) ? currentOrder.items : []).filter((item: any) => item?.is_gift === true);
      const finalItems = [...snapshot, ...giftItems];
      const tokenHash = await sha256Hex(token);
      const { meta: existingMeta } = readNote(String(currentOrder.note ?? ""));
      const submittedNote = typeof body.note === "string" ? body.note.trim().slice(0, 500) : "";
      const newNote = submittedNote ? writeNote(submittedNote, existingMeta) : null;
      const { data, error } = await admin.rpc("apply_customer_order_change_atomic", {
        p_order_id: orderId, p_customer_phone: line.userId, p_capability_hash: tokenHash,
        p_new_items: finalItems, p_new_base_total: total, p_new_note: newNote,
      });
      if (error) {
        if (error.code === "P0002") return reply({ ok: false, error: "此 LINE 帳號沒有這筆訂單的修改權限" }, 403);
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
        note: writeNote(customerNote, { ...meta, proposed_pickup_time: proposed.toISOString(), customer_response: null, needs_reschedule: false }),
      }).eq("id", id);
      if (error) throw error;
      return reply({ ok: true });
    }

    if (action !== "create-order") return reply({ ok: false, error: "Unsupported action" }, 400);
    if (typeof body.website === "string" && body.website.trim()) return reply({ ok: true });
    const lineProfile = await verifyLineIdentity(body.line_access_token);
    const statusToken = randomCapabilityToken();
    const statusTokenHash = await sha256Hex(statusToken);
    const name = String(lineProfile.displayName ?? "").trim().slice(0, 40);
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
      const isDrink = menuItemSettings[id]?.category === "飲品類";
      const spicyEnabled = !isDrink && config.enabled !== false;
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
    if (giftLimit > 0 && hasAvailableGift && selectedGiftCount > 0 && selectedGiftCount !== giftLimit) {
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
    const { error: lineBindError } = await admin.from("customer_orders").update({
      line_user_id: lineProfile.userId, line_display_name: lineProfile.displayName, status_token_hash: statusTokenHash,
    }).eq("id", order.id);
    if (lineBindError) throw lineBindError;
    const { data: numberedOrder, error: numberReadError } = await admin.from("customer_orders").select("daily_sequence").eq("id", order.id).maybeSingle();
    if (numberReadError) throw numberReadError;
    const dailySequence = Number(numberedOrder?.daily_sequence) || null;
    const orderLabel = orderDisplayLabel({ ...order, customer_name: name, daily_sequence: dailySequence });
    const liffId = Deno.env.get("LINE_LIFF_ID") ?? "";
    const statusUrl = liffId ? `https://liff.line.me/${liffId}?order_id=${encodeURIComponent(order.id)}&token=${encodeURIComponent(statusToken)}` : "";
    const linePushTask = statusUrl ? sendLineOrderLink(lineProfile.userId, lineProfile.displayName, orderLabel, statusUrl) : Promise.resolve(false);
    const notificationTask = notifyOwner(admin, "馬鈴吉碳烤｜新訂單", `${orderLabel}（${phone}），LINE：${lineProfile.displayName}，金額 $${total.toLocaleString("zh-TW")}，請開啟訂單管理查看。`);
    const edgeRuntime = (globalThis as any).EdgeRuntime;
    if (edgeRuntime?.waitUntil) edgeRuntime.waitUntil(Promise.allSettled([notificationTask, linePushTask]));
    else await Promise.allSettled([notificationTask, linePushTask]);
    return reply({ ok: true, status_url: statusUrl, id: order.id, order_number: dailySequence ? `#${String(dailySequence).padStart(3, "0")}` : String(order.id).slice(0, 8), daily_sequence: dailySequence, total_amount: total });
  } catch (error) {
    console.error("customer-orders error", error);
    const message = error instanceof Error ? error.message : "訂單處理失敗，請稍後再試";
    const details = error && typeof error === "object" && "code" in error ? String((error as any).code) : undefined;
    console.error("[customer-orders][diagnostic]", { message, code: details });
    const status = Number((error as any)?.status) === 401 ? 401 : 500;
    return reply({ ok: false, error: message, code: details }, status);
  }
});

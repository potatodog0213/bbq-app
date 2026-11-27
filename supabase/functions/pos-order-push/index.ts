/**
 * pos_orders INSERT → 店家 Web Push（現場 / UberEats / foodpanda）
 * 與 customer-orders 的 notifyOwner 使用相同 Secrets 與訂閱表。
 *
 * Secrets（與現有推播相同）：
 *   VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY（平台注入）
 *
 * 觸發：Database Webhook → pos_orders → Insert → 此 Function
 * 或：在 POS 送單後自行 HTTP POST（需帶授權，見下方可選 cron secret）
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "Content-Type": "application/json" },
  });

const CHANNEL_LABEL: Record<string, string> = {
  onsite: "現場",
  ubereats: "UberEats",
  foodpanda: "foodpanda",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return reply({ ok: false, error: "Method not allowed" }, 405);

  // 可選：若設定了 POS_ORDER_PUSH_SECRET，Webhook / 呼叫必須帶相同 x-cron-secret
  const expectedSecret = Deno.env.get("POS_ORDER_PUSH_SECRET") || Deno.env.get("CUSTOMER_ORDER_REMINDER_SECRET");
  if (expectedSecret) {
    const supplied = req.headers.get("x-cron-secret") ?? "";
    // Database Webhook 可能不帶此 header；若你只用 Webhook 且不想設 secret，請不要設定 POS_ORDER_PUSH_SECRET
    // 若有設定且請求沒帶對的 secret，仍允許「像 Webhook 的 body 含 record」時通過？為安全：有 secret 就強制。
    if (supplied !== expectedSecret) {
      // Supabase Database Webhooks 呼叫 Edge Function 時通常帶 service role Authorization，不帶 x-cron-secret。
      // 因此：僅在「有帶 x-cron-secret 但錯」或「非 webhook 風格且無 Authorization」時拒絕。
      const auth = req.headers.get("Authorization") ?? "";
      const hasServiceAuth = auth.startsWith("Bearer ");
      if (!hasServiceAuth && supplied !== expectedSecret) {
        return reply({ ok: false, error: "Unauthorized" }, 401);
      }
      if (supplied && supplied !== expectedSecret) {
        return reply({ ok: false, error: "Unauthorized" }, 401);
      }
    }
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:store@example.com";
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate) {
    return reply({ ok: false, error: "Push function secrets are not configured" }, 500);
  }

  try {
    const body = await req.json().catch(() => ({} as Record<string, unknown>));
    // Database Webhook: { type, table, record, schema, ... }
    const record: Record<string, unknown> =
      (body?.record as Record<string, unknown>) ||
      (body?.new as Record<string, unknown>) ||
      ((body?.payload as Record<string, unknown>)?.record as Record<string, unknown>) ||
      (body as Record<string, unknown>);

    const channel = String(record?.channel ?? "onsite");
    const label = CHANNEL_LABEL[channel] || channel;
    const orderNo = record?.order_no ?? String(record?.id ?? "").slice(0, 8);
    if (!record?.id && record?.order_no == null) {
      return reply({ ok: false, error: "沒有訂單資料", hint: "Webhook 需帶 record" }, 400);
    }

    const title = `馬鈴吉廚房｜${label}新訂單`;
    const message = `訂單 #${orderNo}（${label}）請至廚房畫面查看`;
    // 與 service-worker 的 payload.url 對應；可依你的實際路徑調整
    const payload = JSON.stringify({
      title,
      body: message,
      tag: `pos-${channel}-${record.id || orderNo}`,
      url: "/bbq-app/kitchen-display.html",
    });

    const admin = createClient(url, serviceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const { data: subscriptions, error: subsError } = await admin
      .from("customer_push_subscriptions")
      .select("id,endpoint,p256dh,auth");
    if (subsError) throw subsError;
    if (!subscriptions?.length) {
      return reply({ ok: true, channel, orderNo, sent: 0, reason: "no_store_subscriptions" });
    }

    let sent = 0;
    for (const sub of subscriptions) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
        );
        sent++;
      } catch (e: any) {
        if (e?.statusCode === 404 || e?.statusCode === 410) {
          await admin.from("customer_push_subscriptions").delete().eq("id", sub.id);
        }
        console.warn("[pos-order-push] push failed", e?.statusCode ?? "unknown");
      }
    }

    return reply({ ok: true, channel, orderNo, subscribers: subscriptions.length, sent });
  } catch (error) {
    console.error("[pos-order-push] error", error);
    return reply({
      ok: false,
      error: error instanceof Error ? error.message : "pos-order-push failed",
    }, 500);
  }
});

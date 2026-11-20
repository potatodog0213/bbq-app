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

  const expectedCronSecret = Deno.env.get("CUSTOMER_ORDER_REMINDER_SECRET");
  const suppliedCronSecret = req.headers.get("x-cron-secret") ?? "";
  if (!expectedCronSecret || suppliedCronSecret !== expectedCronSecret) {
    return reply({ ok: false, error: "Unauthorized" }, 401);
  }

  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const vapidPublic = Deno.env.get("VAPID_PUBLIC_KEY");
  const vapidPrivate = Deno.env.get("VAPID_PRIVATE_KEY");
  const vapidSubject = Deno.env.get("VAPID_SUBJECT") ?? "mailto:store@example.com";
  if (!url || !serviceKey || !vapidPublic || !vapidPrivate) {
    return reply({ ok: false, error: "Reminder function secrets are not configured" }, 500);
  }

  try {
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
    const now = Date.now();
    // Cron 每分鐘執行一次；以取餐前 9～11 分鐘的緩衝窗避免排程延遲漏掉提醒。
    const from = new Date(now + 9 * 60_000).toISOString();
    const to = new Date(now + 11 * 60_000).toISOString();
    const { data: orders, error } = await admin.from("customer_orders")
      .select("id,customer_name,pickup_time,total_amount,note")
      .eq("status", "confirmed")
      .gte("pickup_time", from)
      .lte("pickup_time", to)
      .limit(100);
    if (error) throw error;
    if (!orders?.length) return reply({ ok: true, checked: 0, sent: 0 });

    webpush.setVapidDetails(vapidSubject, vapidPublic, vapidPrivate);
    const { data: subscriptions, error: subsError } = await admin
      .from("customer_push_subscriptions").select("id,endpoint,p256dh,auth");
    if (subsError) throw subsError;
    if (!subscriptions?.length) return reply({ ok: true, checked: orders.length, sent: 0, reason: "no_store_subscriptions" });

    let sent = 0;
    for (const order of orders) {
      const { customerNote, meta } = readNote(String(order.note ?? ""));
      if (meta.prep_reminder_sent_at) continue;
      const pickupText = new Date(order.pickup_time).toLocaleString("zh-TW", {
        timeZone: "Asia/Taipei", hour: "2-digit", minute: "2-digit", hour12: false,
      });
      const payload = JSON.stringify({
        title: "馬鈴吉碳烤｜開始備餐提醒",
        body: `${order.customer_name || "客人"} 的訂單預計 ${pickupText} 取餐，請開始製作。`,
        url: "/bbq-app/?customer-order-admin=1",
      });
      let delivered = 0;
      for (const sub of subscriptions) {
        try {
          await webpush.sendNotification(
            { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
            payload,
          );
          delivered++;
        } catch (e: any) {
          if (e?.statusCode === 404 || e?.statusCode === 410) {
            await admin.from("customer_push_subscriptions").delete().eq("id", sub.id);
          }
          console.warn("[customer-order-reminders] push failed", e?.statusCode ?? "unknown");
        }
      }
      if (delivered > 0) {
        const { error: updateError } = await admin.from("customer_orders").update({
          note: writeNote(customerNote, { ...meta, prep_reminder_sent_at: new Date().toISOString() }),
        }).eq("id", order.id);
        if (updateError) throw updateError;
        sent++;
      }
    }
    return reply({ ok: true, checked: orders.length, sent });
  } catch (error) {
    console.error("[customer-order-reminders] error", error);
    return reply({ ok: false, error: error instanceof Error ? error.message : "Reminder failed" }, 500);
  }
});

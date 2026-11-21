-- 馬鈴吉碳烤｜每分鐘執行一次取餐前 10 分鐘提醒
-- 執行前先到 Supabase → Vault → Secrets 建立以下三筆（只存值於 Vault，不要放入 Git）：
-- name = malinji_reminder_project_url；value = https://gyonwgjafukzlmnosykt.supabase.co
-- name = malinji_reminder_anon_key；value = Supabase 舊版 anon/public JWT key（不是 service_role）
-- name = malinji_customer_order_reminder_secret；value = 自行產生的至少 32 bytes 隨機字串
-- 同一組提醒字串也要設為 Edge Function Secret：CUSTOMER_ORDER_REMINDER_SECRET
-- 此排程只使用 anon key + 自訂 Cron Secret，不使用 service_role key。
-- 先部署 customer-order-reminders，再執行本 SQL。此腳本不會修改訂單。

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'malinji-customer-order-prep-reminder';
SELECT cron.schedule(
  'malinji-customer-order-prep-reminder',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'malinji_reminder_project_url' LIMIT 1) || '/functions/v1/customer-order-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'malinji_reminder_anon_key' LIMIT 1),
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'malinji_reminder_anon_key' LIMIT 1),
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'malinji_customer_order_reminder_secret' LIMIT 1)
    ),
    body := '{}'::jsonb
  );
  $$
);

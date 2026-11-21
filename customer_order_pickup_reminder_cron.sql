-- 先在 Supabase Dashboard > Vault 建立兩筆 Secrets：
-- 1. name = customer_orders_reminder_secret，value = 你自行產生的 64 位隨機字串
-- 2. name = supabase_service_role_key，value = 你的 Supabase service_role key（不要放進前端）
-- 並在 Edge Function Secrets 設定 ORDER_REMINDER_CRON_SECRET 為同一組 reminder secret。

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

SELECT cron.unschedule(jobid)
FROM cron.job
WHERE jobname = 'customer-order-pickup-reminders';

SELECT cron.schedule(
  'customer-order-pickup-reminders',
  '* * * * *',
  $$
  SELECT net.http_post(
    url := 'https://gyonwgjafukzlmnosykt.supabase.co/functions/v1/customer-orders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1),
      'apikey', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'supabase_service_role_key' LIMIT 1)
    ),
    body := jsonb_build_object(
      'action', 'send-pickup-reminders',
      'secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'customer_orders_reminder_secret' LIMIT 1)
    )
  );
  $$
);

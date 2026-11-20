-- 先在 Supabase Edge Function Secrets 設定 CUSTOMER_ORDER_REMINDER_SECRET。
-- 將下方兩處 PASTE_THE_SAME_LONG_RANDOM_SECRET 替換成同一組隨機字串。
-- 專案 publishable key 是公開金鑰，這裡使用網站現有的 publishable key。

select vault.create_secret(
  'https://gyonwgjafukzlmnosykt.supabase.co',
  'malinji_customer_orders_project_url'
);

select vault.create_secret(
  'PASTE_THE_SAME_LONG_RANDOM_SECRET',
  'malinji_customer_order_reminder_secret'
);

select cron.schedule(
  'malinji-customer-order-prep-reminder',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'malinji_customer_orders_project_url') || '/functions/v1/customer-order-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'apikey', 'sb_publishable_T6IA7G9XaIvuGN-fOMX7Xw_FlPoi0OP',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'malinji_customer_order_reminder_secret')
    ),
    body := '{}'::jsonb
  ) as request_id;
  $$
);

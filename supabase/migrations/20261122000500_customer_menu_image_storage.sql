-- 馬鈴吉碳烤：公開餐點照片 bucket 與存取政策。
-- 不修改 products 或任何既有訂單資料。
BEGIN;

INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('customer-menu-images', 'customer-menu-images', true, 12582912, ARRAY['image/webp','image/jpeg','image/png','image/avif'])
ON CONFLICT (id) DO UPDATE SET public = true, file_size_limit = 12582912, allowed_mime_types = EXCLUDED.allowed_mime_types;

DROP POLICY IF EXISTS "Store owners upload menu images" ON storage.objects;
CREATE POLICY "Store owners upload menu images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'customer-menu-images' AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');
DROP POLICY IF EXISTS "Store owners update menu images" ON storage.objects;
CREATE POLICY "Store owners update menu images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'customer-menu-images' AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner')
  WITH CHECK (bucket_id = 'customer-menu-images' AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');
DROP POLICY IF EXISTS "Store owners delete menu images" ON storage.objects;
CREATE POLICY "Store owners delete menu images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'customer-menu-images' AND (auth.jwt() -> 'app_metadata' ->> 'role') = 'store_owner');
DROP POLICY IF EXISTS "Public read menu images" ON storage.objects;
CREATE POLICY "Public read menu images" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'customer-menu-images');

COMMIT;

-- ===============================================================================================================
-- 073: web chat header logo upload (Settings → Websites → Design → Logo).
-- The logo is cropped in the browser and saved as WebP under <workspace_id>/<inbox_id>/logo/ in the media bucket.
-- Safari cannot encode WebP from a canvas and hands back PNG, so the bucket also takes image/png.
-- Same policies as 053 (the path's first folder is still the workspace), so nothing else changes.
-- ===============================================================================================================
update storage.buckets
   set allowed_mime_types = array['video/mp4','video/webm','image/gif','image/webp','image/png']
 where id = 'outreach-webchat-media';

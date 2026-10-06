-- Local uploads are stored as root-relative URLs so phones on the LAN and the web resolve them alike.
CREATE FUNCTION pg_temp.relative_upload_url(url TEXT) RETURNS TEXT AS $$
  SELECT regexp_replace(url, '^https?://[^/]+(/v1/uploads/)', '\1')
$$ LANGUAGE SQL IMMUTABLE;

CREATE FUNCTION pg_temp.relative_upload_urls(urls TEXT[]) RETURNS TEXT[] AS $$
  SELECT coalesce(array_agg(pg_temp.relative_upload_url(u) ORDER BY n), '{}')
  FROM unnest(urls) WITH ORDINALITY AS t(u, n)
$$ LANGUAGE SQL IMMUTABLE;

UPDATE "products" SET "photos" = pg_temp.relative_upload_urls("photos")
WHERE "photos"::TEXT ~ 'https?://[^/,]+/v1/uploads/';

UPDATE "products" SET "imageUrl" = pg_temp.relative_upload_url("imageUrl")
WHERE "imageUrl" ~ '^https?://[^/]+/v1/uploads/';

UPDATE "picking_orders" SET "photos" = pg_temp.relative_upload_urls("photos")
WHERE "photos"::TEXT ~ 'https?://[^/,]+/v1/uploads/';

UPDATE "packing_orders" SET "photos" = pg_temp.relative_upload_urls("photos")
WHERE "photos"::TEXT ~ 'https?://[^/,]+/v1/uploads/';

UPDATE "shipments" SET "proofPhotoUrl" = pg_temp.relative_upload_url("proofPhotoUrl")
WHERE "proofPhotoUrl" ~ '^https?://[^/]+/v1/uploads/';

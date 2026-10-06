-- The tenant that holds the pre-SaaS installation keeps working without plan limits.
UPDATE "tenants" SET "plan" = 'enterprise' WHERE "id" = '00000000-0000-4000-8000-000000000001';

-- Existing tokens were stored in plain text; they are invalidated and users must sign in again.
DELETE FROM "refresh_tokens";

ALTER TABLE "refresh_tokens" RENAME COLUMN "token" TO "tokenHash";
ALTER INDEX "refresh_tokens_token_key" RENAME TO "refresh_tokens_tokenHash_key";

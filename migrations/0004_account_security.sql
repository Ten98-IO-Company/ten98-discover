ALTER TABLE "user" ADD COLUMN "twoFactorEnabled" boolean NOT NULL DEFAULT false;

CREATE TABLE "twoFactor" (
  id text PRIMARY KEY,
  "userId" text NOT NULL UNIQUE REFERENCES "user"(id) ON DELETE CASCADE,
  secret text NOT NULL,
  "backupCodes" text NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz
);

CREATE INDEX session_user_active_idx ON session("userId", "expiresAt");

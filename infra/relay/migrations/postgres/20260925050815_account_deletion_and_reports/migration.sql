CREATE TABLE IF NOT EXISTS "relay_account_deletions" (
	"user_id" varchar(255) PRIMARY KEY,
	"request_id" varchar(64) NOT NULL,
	"source" varchar(32) NOT NULL,
	"status" varchar(16) NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error_code" varchar(64),
	"requested_at" varchar(64) NOT NULL,
	"next_attempt_at" varchar(64) NOT NULL,
	"completed_at" varchar(64),
	"updated_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_ai_reports" (
	"id" varchar(36) PRIMARY KEY,
	"reason" varchar(32) NOT NULL,
	"excerpt" text NOT NULL,
	"notes" text NOT NULL,
	"content_hash" varchar(64) NOT NULL,
	"received_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "relay_identity_checks" (
	"user_id" varchar(255) PRIMARY KEY,
	"checked_at" varchar(64) NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relay_account_deletions_due" ON "relay_account_deletions" ("status","next_attempt_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_relay_ai_reports_received_at" ON "relay_ai_reports" ("received_at");
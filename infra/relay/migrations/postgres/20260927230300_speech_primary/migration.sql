CREATE TABLE "relay_speech_primary" (
	"user_id" varchar(255) PRIMARY KEY,
	"environment_id" varchar(191),
	"integration_id" varchar(80),
	"revision" integer NOT NULL
);

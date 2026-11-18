CREATE TYPE "public"."cleanup_mode" AS ENUM('off', 'trim', 'cutout');--> statement-breakpoint
CREATE TYPE "public"."film_format" AS ENUM('instax_wide', 'instax_square', 'instax_mini', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."layout_status" AS ENUM('draft', 'published', 'archived');--> statement-breakpoint
CREATE TYPE "public"."placement_source" AS ENUM('suggested', 'manual');--> statement-breakpoint
CREATE TYPE "public"."print_size" AS ENUM('standard', 'large');--> statement-breakpoint
CREATE TYPE "public"."print_status" AS ENUM('processing', 'ready', 'needs_attention', 'duplicate', 'failed');--> statement-breakpoint
CREATE TYPE "public"."upload_status" AS ENUM('uploading', 'uploaded', 'processing', 'done', 'failed', 'skipped', 'aborted');--> statement-breakpoint
CREATE TABLE "cleanup" (
	"print_id" uuid PRIMARY KEY NOT NULL,
	"mode" "cleanup_mode" DEFAULT 'off' NOT NULL,
	"rect" jsonb,
	"auto" boolean DEFAULT true NOT NULL,
	"approved" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "cleanup" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "copies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"print_id" uuid NOT NULL,
	"size" integer NOT NULL,
	"format" text NOT NULL,
	"storage_key" text NOT NULL,
	"width" integer NOT NULL,
	"height" integer NOT NULL,
	"bytes" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "copies" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "layout_versions" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" "layout_status" NOT NULL,
	"frame" jsonb NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"published_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "layout_versions" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "originals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"storage_key" text NOT NULL,
	"filename" text NOT NULL,
	"bytes" bigint NOT NULL,
	"sha256" text NOT NULL,
	"mime" text NOT NULL,
	"width" integer,
	"height" integer,
	"bit_depth" integer,
	"color_profile" text,
	"dpi" real,
	"pages" integer,
	"analysis" jsonb,
	"replaced_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "originals_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "originals" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "placements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"version_id" integer NOT NULL,
	"print_id" uuid NOT NULL,
	"x" real NOT NULL,
	"y" real NOT NULL,
	"rotation" real NOT NULL,
	"size" "print_size" DEFAULT 'standard' NOT NULL,
	"layer" integer NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"source" "placement_source" DEFAULT 'suggested' NOT NULL,
	"suggested" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "placements" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "prints" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" text NOT NULL,
	"original_id" uuid NOT NULL,
	"box_index" integer DEFAULT 0 NOT NULL,
	"status" "print_status" DEFAULT 'processing' NOT NULL,
	"issue" text,
	"film" "film_format" DEFAULT 'unknown' NOT NULL,
	"width_px" integer,
	"height_px" integer,
	"dhash" text,
	"border_ink" real,
	"duplicate_of_id" uuid,
	"copy_version" text,
	"copy_sizes" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prints_number_unique" UNIQUE("number")
);
--> statement-breakpoint
ALTER TABLE "prints" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "settings" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "settings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TABLE "uploads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"batch_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"bytes" bigint NOT NULL,
	"mime" text NOT NULL,
	"sha256" text NOT NULL,
	"storage_key" text NOT NULL,
	"s3_upload_id" text,
	"part_size" integer NOT NULL,
	"parts_done" integer DEFAULT 0 NOT NULL,
	"status" "upload_status" DEFAULT 'uploading' NOT NULL,
	"error" text,
	"original_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "uploads_storage_key_unique" UNIQUE("storage_key")
);
--> statement-breakpoint
ALTER TABLE "uploads" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "cleanup" ADD CONSTRAINT "cleanup_print_id_prints_id_fk" FOREIGN KEY ("print_id") REFERENCES "public"."prints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "copies" ADD CONSTRAINT "copies_print_id_prints_id_fk" FOREIGN KEY ("print_id") REFERENCES "public"."prints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_version_id_layout_versions_id_fk" FOREIGN KEY ("version_id") REFERENCES "public"."layout_versions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placements" ADD CONSTRAINT "placements_print_id_prints_id_fk" FOREIGN KEY ("print_id") REFERENCES "public"."prints"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prints" ADD CONSTRAINT "prints_original_id_originals_id_fk" FOREIGN KEY ("original_id") REFERENCES "public"."originals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "copies_print_size_format" ON "copies" USING btree ("print_id","size","format");--> statement-breakpoint
CREATE INDEX "originals_sha256_idx" ON "originals" USING btree ("sha256");--> statement-breakpoint
CREATE UNIQUE INDEX "placements_version_print" ON "placements" USING btree ("version_id","print_id");--> statement-breakpoint
CREATE INDEX "uploads_sha_idx" ON "uploads" USING btree ("sha256");
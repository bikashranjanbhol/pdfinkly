/**
 * Drizzle mirror of migrations/0001_init.sql, for typed queries.
 * The SQL migration is the source of truth (it also holds triggers,
 * partial indexes and the deferrable FK that Drizzle doesn't model).
 * Property names on the auth tables follow the Auth.js adapter contract.
 */
import {
  bigint,
  boolean,
  customType,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

const citext = customType<{ data: string }>({ dataType: () => "citext" });
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const paymentProvider = pgEnum("payment_provider", ["stripe", "razorpay"]);
export const subscriptionStatus = pgEnum("subscription_status", ["trialing", "active", "past_due", "cancelled", "expired"]);
export const paymentStatus = pgEnum("payment_status", ["pending", "succeeded", "failed", "refunded"]);
export const fileStatus = pgEnum("file_status", ["uploading", "ready", "processing", "failed"]);
export const versionSource = pgEnum("version_source", ["upload", "edit", "job"]);
export const jobType = pgEnum("job_type", ["compress", "ocr", "pdf_to_docx", "pdf_to_xlsx", "pdf_to_pptx", "office_to_pdf", "encrypt", "decrypt"]);
export const jobStatus = pgEnum("job_status", ["queued", "running", "succeeded", "failed", "cancelled"]);
export const sharePermission = pgEnum("share_permission", ["view", "edit"]);
export const signatureKind = pgEnum("signature_kind", ["drawn", "typed", "uploaded"]);
export const usageKind = pgEnum("usage_kind", ["upload", "job"]);

export const plans = pgTable("plans", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  maxFileMb: integer("max_file_mb").notNull(),
  monthlyJobs: integer("monthly_jobs"),
  retentionHours: integer("retention_hours"),
  features: jsonb("features").$type<Record<string, boolean>>().notNull().default({}),
  stripePriceId: text("stripe_price_id"),
  razorpayPlanId: text("razorpay_plan_id"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: citext("email").unique(),
  name: text("name"),
  image: text("image_url"),
  emailVerified: ts("email_verified"),
  isGuest: boolean("is_guest").notNull().default(false),
  planId: text("plan_id").notNull().default("free").references(() => plans.id),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const accounts = pgTable("accounts", {
  id: uuid("id").primaryKey().defaultRandom(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type").notNull(),
  provider: text("provider").notNull(),
  providerAccountId: text("provider_account_id").notNull(),
  refresh_token: text("refresh_token"),
  access_token: text("access_token"),
  expires_at: bigint("expires_at", { mode: "number" }),
  token_type: text("token_type"),
  scope: text("scope"),
  id_token: text("id_token"),
  session_state: text("session_state"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const sessions = pgTable("sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  sessionToken: text("session_token").notNull().unique(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  expires: ts("expires_at").notNull(),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const verificationTokens = pgTable(
  "verification_tokens",
  {
    identifier: text("identifier").notNull(),
    token: text("token").notNull(),
    expires: ts("expires_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.identifier, t.token] })],
);

export const files = pgTable("files", {
  id: uuid("id").primaryKey().defaultRandom(),
  ownerId: uuid("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  mimeType: text("mime_type").notNull().default("application/pdf"),
  status: fileStatus("status").notNull().default("uploading"),
  currentVersionId: uuid("current_version_id"),
  isEncrypted: boolean("is_encrypted").notNull().default(false),
  expiresAt: ts("expires_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  deletedAt: ts("deleted_at"),
});

export const fileVersions = pgTable("file_versions", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  versionNo: integer("version_no").notNull(),
  source: versionSource("source").notNull(),
  storageKey: text("storage_key").notNull().unique(),
  sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
  sha256: text("sha256"),
  pageCount: integer("page_count"),
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const editDrafts = pgTable("edit_drafts", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  baseVersionId: uuid("base_version_id").notNull().references(() => fileVersions.id, { onDelete: "cascade" }),
  operations: jsonb("operations").$type<unknown[]>().notNull().default([]),
  revision: integer("revision").notNull().default(1),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
});

export const shareLinks = pgTable("share_links", {
  id: uuid("id").primaryKey().defaultRandom(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  createdBy: uuid("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  permission: sharePermission("permission").notNull().default("view"),
  expiresAt: ts("expires_at"),
  revokedAt: ts("revoked_at"),
  createdAt: ts("created_at").notNull().defaultNow(),
});

export const usageEvents = pgTable("usage_events", {
  id: bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity(),
  userId: uuid("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: usageKind("kind").notNull(),
  quantity: bigint("quantity", { mode: "number" }).notNull().default(1),
  jobId: uuid("job_id"),
  occurredAt: ts("occurred_at").notNull().defaultNow(),
});

export type User = typeof users.$inferSelect;
export type FileRow = typeof files.$inferSelect;
export type FileVersionRow = typeof fileVersions.$inferSelect;
export type Plan = typeof plans.$inferSelect;

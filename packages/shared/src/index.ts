import { z } from "zod";
import { OperationsSchema } from "./operations";

export * from "./operations";

/* ------------------------------------------------------------- API shapes */

export const CreateFileBody = z.object({
  name: z.string().trim().min(1).max(255),
  sizeBytes: z.number().int().positive(),
});

export const CreateVersionBody = z.object({
  sizeBytes: z.number().int().positive(),
  baseVersionId: z.string().uuid().optional(),
});

export const CompleteVersionBody = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  pageCount: z.number().int().min(1).max(10000),
  source: z.enum(["upload", "edit"]).default("upload"),
});

export const RenameFileBody = z.object({ name: z.string().trim().min(1).max(255) });
export const RestoreBody = z.object({ versionId: z.string().uuid() });

export const SaveDraftBody = z.object({
  baseVersionId: z.string().uuid(),
  operations: OperationsSchema,
  /** The revision the client last saw; 0 when creating the draft. */
  revision: z.number().int().min(0),
});

export const CreateShareBody = z.object({
  permission: z.enum(["view"]).default("view"),
  expiresInDays: z.union([z.literal(1), z.literal(7), z.literal(30), z.null()]).default(7),
});

export type ErrorCode =
  | "VALIDATION_FAILED"
  | "UNAUTHENTICATED"
  | "PLAN_FEATURE_LOCKED"
  | "NOT_FOUND"
  | "DRAFT_CONFLICT"
  | "FILE_TOO_LARGE"
  | "UPLOAD_MISSING"
  | "SIZE_MISMATCH"
  | "INVALID_PDF"
  | "RATE_LIMITED"
  | "INTERNAL";

export interface ApiError {
  error: { code: ErrorCode; message: string; details?: unknown };
}

export interface FileSummary {
  id: string;
  name: string;
  status: "uploading" | "ready" | "processing" | "failed";
  pageCount: number | null;
  sizeBytes: number | null;
  currentVersionId: string | null;
  hasDraft: boolean;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface VersionInfo {
  id: string;
  versionNo: number;
  source: "upload" | "edit" | "job";
  sizeBytes: number;
  pageCount: number | null;
  createdAt: string;
}

export interface UploadTicket {
  url: string;
  method: "PUT";
  headers: Record<string, string>;
  expiresAt: string;
}
export * from "./fonts";
export * from "./ocrTypes";
export * from "./visual";
export * from "./pii";
export * from "./stampLayout";

import "server-only";
import { NextResponse } from "next/server";
import type { z } from "zod";
import type { ApiError, ErrorCode } from "@pdfinkly/shared";

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  PLAN_FEATURE_LOCKED: 403,
  NOT_FOUND: 404,
  DRAFT_CONFLICT: 409,
  FILE_TOO_LARGE: 413,
  UPLOAD_MISSING: 422,
  SIZE_MISMATCH: 422,
  INVALID_PDF: 422,
  RATE_LIMITED: 429,
  QUOTA_EXCEEDED: 402,
  ALREADY_SUBSCRIBED: 409,
  PAYMENT_INVALID: 400,
  PAYMENTS_UNAVAILABLE: 503,
  INTERNAL: 500,
};

export class HttpError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public details?: unknown,
    public headers?: Record<string, string>,
  ) {
    super(message);
  }
}

export const ok = <T>(data: T, init?: number | ResponseInit) =>
  NextResponse.json(data, typeof init === "number" ? { status: init } : init);

export const noContent = () => new NextResponse(null, { status: 204 });

export function errorResponse(e: unknown): NextResponse<ApiError> {
  if (e instanceof HttpError) {
    return NextResponse.json(
      { error: { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) } },
      { status: STATUS[e.code], headers: e.headers },
    );
  }
  console.error(e);
  return NextResponse.json({ error: { code: "INTERNAL", message: "Something went wrong." } }, { status: 500 });
}

/** Wrap a route handler so thrown HttpErrors become the standard error JSON. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (e) {
      return errorResponse(e);
    }
  };
}

export async function parseBody<S extends z.ZodType>(req: Request, schema: S): Promise<z.output<S>> {
  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    throw new HttpError("VALIDATION_FAILED", "Request body must be JSON.");
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new HttpError("VALIDATION_FAILED", "Request body is invalid.", parsed.error.issues.slice(0, 10));
  }
  return parsed.data;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Route params arrive as strings; anything that is not a UUID is simply "not found". */
export function uuidParam(v: string): string {
  if (!UUID.test(v)) throw new HttpError("NOT_FOUND", "Not found.");
  return v;
}

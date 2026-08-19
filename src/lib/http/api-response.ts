import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "AUTH_PROVIDER_UNAVAILABLE"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "PROCESSING_JOB_MODE_CONFLICT"
  | "PROCESSING_JOB_ORIGIN_CONFLICT"
  | "PROCESSING_CONFLICT"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DATABASE_ERROR"
  | "EXTERNAL_API_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export function ok<T>(
  data: T,
  message = "Operação realizada com sucesso.",
  status = 200
) {
  return NextResponse.json({ success: true, data, message }, { status });
}

export function fail(code: ApiErrorCode, message: string, status = 400) {
  return NextResponse.json({ success: false, error: { code, message } }, { status });
}

export function failWithDetails(
  code: ApiErrorCode,
  message: string,
  details: unknown,
  status = 400
) {
  return NextResponse.json(
    { success: false, error: { code, message, details } },
    { status }
  );
}

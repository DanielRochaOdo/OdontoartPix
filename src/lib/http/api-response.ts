import { NextResponse } from "next/server";

export type ApiErrorCode =
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "CONFLICT"
  | "DATABASE_ERROR"
  | "EXTERNAL_API_ERROR"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export function ok<T>(data: T, message = "Operação realizada com sucesso.") {
  return NextResponse.json({ success: true, data, message });
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
  return NextResponse.json({ success: false, error: { code, message, details } }, { status });
}

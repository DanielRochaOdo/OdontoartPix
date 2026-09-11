import { z } from "zod";
import { requireApiUser } from "@/lib/auth/require-api-user";
import { createDispatchOperation } from "@/lib/dispatches";
import { fail, ok } from "@/lib/http/api-response";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TextArray = z.array(z.string().trim().min(1)).max(200).default([]);

const FiltersSchema = z.object({
  query: z.string().max(200).optional(),
  code: z.string().max(100).optional(),
  installment: z.string().max(100).optional(),
  dueDateFrom: DateSchema.optional().or(z.literal("")),
  dueDateTo: DateSchema.optional().or(z.literal("")),
  paymentDateFrom: DateSchema.optional().or(z.literal("")),
  paymentDateTo: DateSchema.optional().or(z.literal("")),
  status: TextArray.optional(),
  payment: TextArray.optional(),
  paidPending: z.enum(["all", "yes", "no"]).optional(),
  receipt: TextArray.optional(),
  installmentType: TextArray.optional(),
  campaign: z.array(z.string().uuid()).max(200).optional(),
  batch: z.array(z.string().uuid()).max(200).optional(),
  dispatchCount: z.enum(["all", "never", "1", "2", "3", "4plus"]).optional(),
  lastDispatchFrom: DateSchema.optional().or(z.literal("")),
  lastDispatchTo: DateSchema.optional().or(z.literal(""))
});

const BodySchema = z.object({
  requestKey: z.string().uuid(),
  dispatchDate: DateSchema,
  filters: FiltersSchema.default({}),
  targetIds: z.array(z.string().uuid()).max(20_000).optional()
});

export async function POST(request: Request) {
  const auth = await requireApiUser(["administrador", "operador"]);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  const parsed = BodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("VALIDATION_ERROR", "Dados invalidos para registrar os disparos.", 400);
  }

  try {
    return ok(await createDispatchOperation({
      ...parsed.data,
      createdBy: auth.user.id
    }));
  } catch (error) {
    const message = error instanceof Error ? error.message : "Nao foi possivel registrar os disparos.";
    return fail("INVALID_REQUEST", message, 400);
  }
}

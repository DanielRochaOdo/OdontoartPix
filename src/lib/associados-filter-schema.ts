import { z } from "zod";

const DateSchema = z.union([z.literal(""), z.string().regex(/^\d{4}-\d{2}-\d{2}$/)]);
const TextArray = z.array(z.string().trim().min(1)).max(200).optional();

export const AssociadosFiltersSchema = z.object({
  query: z.string().max(200).optional(),
  code: z.string().max(100).optional(),
  installment: z.string().max(100).optional(),
  dueDateFrom: DateSchema.optional(),
  dueDateTo: DateSchema.optional(),
  paymentDateFrom: DateSchema.optional(),
  paymentDateTo: DateSchema.optional(),
  status: TextArray,
  payment: TextArray,
  paidPending: z.enum(["all", "yes", "no"]).optional(),
  receipt: TextArray,
  installmentType: TextArray,
  campaign: z.array(z.string().uuid()).max(200).optional(),
  batch: z.array(z.string().uuid()).max(200).optional()
});

export const AssociadosSortSchema = z.enum([
  "name", "associatedCode", "installment", "dueDate",
  "campaign", "batch", "status", "payment", "pending"
]);

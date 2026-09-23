import { z } from "zod";

const DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const TextArray = z.array(z.string().trim().min(1)).max(200).default([]);

export const DispatchFiltersSchema = z.object({
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


export type IgnoredImportEventInput = {
  campaignId: string;
  campaignName: string;
  batchId: string | null;
  batchName: string | null;
  createdBy: string;
  issues: Array<{
    line?: number;
    associatedCode?: string;
    targetInstallmentId?: string;
    installmentAmountCents?: number | null;
    cpf?: string;
    name?: string;
    reason?: string;
  }>;
};

export type ProcessingEventInput = {
  campaignId: string;
  batchId: string;
  eventType: "processing_block_completed" | "processing_job_completed" | "processing_job_failed";
  reason: string;
  details: Record<string, unknown>;
};

export type InfrastructureHealthEventInput = {
  eventType: "erp_instability_detected" | "supabase_latency_detected";
  severity: "warning" | "error";
  campaignId: string;
  batchId: string;
  reason: string;
  details: Record<string, unknown>;
};

// Diagnosticos operacionais sao efemeros. Nada deste modulo e persistido no
// Supabase; os dados existem somente nos logs do processo/runner atual.
export async function logProcessingEvent(input: ProcessingEventInput) {
  console.info("[PROCESSING_EVENT]", {
    eventType: input.eventType,
    campaignId: input.campaignId,
    batchId: input.batchId,
    reason: input.reason,
    ...input.details
  });
}

export async function logInfrastructureHealthEvent(input: InfrastructureHealthEventInput) {
  const payload = {
    eventType: input.eventType,
    campaignId: input.campaignId,
    batchId: input.batchId,
    reason: input.reason,
    ...input.details
  };

  if (input.severity === "error") {
    console.error("[INFRASTRUCTURE_HEALTH]", payload);
    return;
  }

  console.warn("[INFRASTRUCTURE_HEALTH]", payload);
}

export async function logIgnoredImportEvents(input: IgnoredImportEventInput) {
  if (input.issues.length === 0) return;

  // Nao imprime CPF, nome, codigo de associado ou parcela. O resumo detalhado
  // continua sendo devolvido ao usuario pela resposta da importacao.
  console.warn("[IMPORT_RECORDS_IGNORED]", {
    campaignId: input.campaignId,
    batchId: input.batchId,
    totalIssues: input.issues.length
  });
}

type DispatchContext = {
  source: "campaign" | "batch" | "campaign-errors" | "dashboard-general-sync";
  campaignId?: string;
  batchId?: string;
  requestedBy?: string;
};

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required durable processing env: ${name}`);
  }
  return value;
}

export async function dispatchDurableProcessingWorkflow(context: DispatchContext) {
  const token = readRequiredEnv("GITHUB_ACTIONS_TOKEN");
  const owner = readRequiredEnv("GITHUB_ACTIONS_REPO_OWNER");
  const repo = readRequiredEnv("GITHUB_ACTIONS_REPO_NAME");
  const workflowId = process.env.GITHUB_ACTIONS_WORKFLOW_ID?.trim() || "process-batches.yml";
  const ref = process.env.GITHUB_ACTIONS_REF?.trim() || "main";

  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "odontoartpix-durable-dispatch"
      },
      body: JSON.stringify({
        ref,
        inputs: {
          source: context.source,
          campaign_id: context.campaignId ?? "",
          batch_id: context.batchId ?? "",
          requested_by: context.requestedBy ?? ""
        }
      })
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Failed to dispatch durable processing workflow: ${response.status} ${body}`.slice(0, 1000)
    );
  }
}

export type DurableDispatchResult = {
  ok: boolean;
  error: string | null;
};

export async function dispatchDurableProcessingWorkflowSafely(
  context: DispatchContext
): Promise<DurableDispatchResult> {
  try {
    await dispatchDurableProcessingWorkflow(context);
    return {
      ok: true,
      error: null
    };
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Erro desconhecido ao despachar o worker duravel.";
    console.error("[DURABLE_PROCESSING_DISPATCH_FAILED]", {
      context,
      message
    });
    return {
      ok: false,
      error: message.slice(0, 1000)
    };
  }
}

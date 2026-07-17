import { jsonOk } from "@/app/api/_shared/route-utils";
export async function POST(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonOk({ batchId: id, status: "reprocessing_errors" });
}

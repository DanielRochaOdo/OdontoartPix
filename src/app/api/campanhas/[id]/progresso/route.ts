import { jsonOk } from "@/app/api/_shared/route-utils";
export async function GET(_: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return jsonOk({ campaignId: id, progress: 0 });
}

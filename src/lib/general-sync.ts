// Fachada estável para consumidores antigos. A implementação operacional da
// sincronização geral está inteiramente nos módulos PostgreSQL locais.

export type {
  GeneralSyncRunDetail,
  GeneralSyncRunStatus
} from "@/lib/general-sync-read";

export {
  getActiveGeneralSyncRun,
  getGeneralSyncRun
} from "@/lib/general-sync-read";

export type {
  GeneralSyncPreview,
  GeneralSyncScopeInput,
  GeneralSyncScopeResolution
} from "@/lib/general-sync-preview";

export {
  getGeneralSyncPreview,
  resolveGeneralSyncScope
} from "@/lib/general-sync-preview";

export type { LocalGeneralSyncStartResult } from "@/lib/general-sync-start";
export { createLocalGeneralSyncRun } from "@/lib/general-sync-start";

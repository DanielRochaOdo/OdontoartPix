import { dbQuery } from "@/lib/db/pool";

export const ACTIVE_LIVES_COLLECTION_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;
const FORTALEZA_OFFSET = "-03:00";

type SnapshotRow = {
  id: string;
  totalVidasAtivas: number;
  totalTitularesAtivos: number;
  totalDependentesAtivos: number;
  dataConsulta: Date | string;
  collectedAt: Date | string;
};

export type ActiveLivesSnapshot = {
  id: string;
  totalVidasAtivas: number;
  totalTitularesAtivos: number;
  totalDependentesAtivos: number;
  dataConsulta: string;
  collectedAt: string;
};

export type ActiveLivesGrowth = {
  absolute: number;
  percentage: number | null;
};

export type ActiveLivesDashboardData = {
  latest: ActiveLivesSnapshot | null;
  period: {
    from: string;
    to: string;
    first: ActiveLivesSnapshot | null;
    last: ActiveLivesSnapshot | null;
    growth: {
      totalVidasAtivas: ActiveLivesGrowth;
      totalTitularesAtivos: ActiveLivesGrowth;
      totalDependentesAtivos: ActiveLivesGrowth;
    };
  };
  trend: ActiveLivesSnapshot[];
  sampling: "hour" | "day";
  collectionIntervalMinutes: 5;
};

function requiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
  return value;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readNonNegativeInteger(value: unknown, field: string) {
  const parsed = typeof value === "number" ? value : Number(String(value ?? "").trim());
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Campo inválido retornado pela API: ${field}`);
  }
  return Math.trunc(parsed);
}

export function normalizeDataConsulta(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString();
  if (typeof value !== "string" || !value.trim()) {
    throw new Error("Campo inválido retornado pela API: dataConsulta");
  }

  const raw = value.trim();
  const brazilian = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/);
  if (brazilian) {
    const [, day, month, year, hour = "00", minute = "00", second = "00"] = brazilian;
    const parsed = new Date(`${year}-${month}-${day}T${hour}:${minute}:${second}${FORTALEZA_OFFSET}`);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const isoWithoutZone = raw.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?$/);
  const parsed = new Date(isoWithoutZone ? `${raw}${FORTALEZA_OFFSET}` : raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error("Campo inválido retornado pela API: dataConsulta");
  }
  return parsed.toISOString();
}

export function parseActiveLivesPayload(raw: unknown) {
  const root = asObject(raw);
  if (!root) throw new Error("Resposta inválida da API de vidas ativas.");

  const candidates = [root, asObject(root.data), asObject(root.result), asObject(root.payload)].filter(
    Boolean
  ) as Record<string, unknown>[];
  const payload = candidates.find((candidate) => "totalVidasAtivas" in candidate);
  if (!payload) throw new Error("A API não retornou o campo totalVidasAtivas.");

  return {
    totalVidasAtivas: readNonNegativeInteger(payload.totalVidasAtivas, "totalVidasAtivas"),
    totalTitularesAtivos: readNonNegativeInteger(
      payload.totalTitularesAtivos,
      "totalTitularesAtivos"
    ),
    totalDependentesAtivos: readNonNegativeInteger(
      payload.totalDependentesAtivos,
      "totalDependentesAtivos"
    ),
    dataConsulta: normalizeDataConsulta(payload.dataConsulta)
  };
}

function buildEndpointUrl() {
  const configured = requiredEnv("VIDAS_ATIVAS_API_ENDPOINT");
  const token = requiredEnv("VIDAS_ATIVAS_API_TOKEN");
  let url: URL;

  try {
    const base = new URL(configured);
    const alreadyFullEndpoint = base.pathname.includes("/v2/api/contratos/vidasAtivas");
    url = alreadyFullEndpoint ? base : new URL("/v2/api/contratos/vidasAtivas", base);
  } catch {
    throw new Error("VIDAS_ATIVAS_API_ENDPOINT precisa ser uma URL HTTPS válida.");
  }

  if (url.protocol !== "https:") {
    throw new Error("VIDAS_ATIVAS_API_ENDPOINT precisa usar HTTPS.");
  }

  url.searchParams.set("token", token);
  return url;
}

async function fetchActiveLives() {
  const controller = new AbortController();
  const configuredTimeout = Number(process.env.VIDAS_ATIVAS_API_TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(configuredTimeout) && configuredTimeout > 0
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildEndpointUrl(), {
      method: "GET",
      cache: "no-store",
      headers: { accept: "application/json" },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`API de vidas ativas respondeu HTTP ${response.status}.`);
    }

    return parseActiveLivesPayload(await response.json());
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Tempo limite excedido ao consultar vidas ativas (${timeoutMs} ms).`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function toIso(value: Date | string) {
  if (value instanceof Date) return value.toISOString();
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? String(value) : parsed.toISOString();
}

function serializeSnapshot(row: SnapshotRow): ActiveLivesSnapshot {
  return {
    id: String(row.id),
    totalVidasAtivas: Number(row.totalVidasAtivas),
    totalTitularesAtivos: Number(row.totalTitularesAtivos),
    totalDependentesAtivos: Number(row.totalDependentesAtivos),
    dataConsulta: toIso(row.dataConsulta),
    collectedAt: toIso(row.collectedAt)
  };
}

const SNAPSHOT_SELECT = `
  id::text as id,
  total_active_lives as "totalVidasAtivas",
  total_active_holders as "totalTitularesAtivos",
  total_active_dependents as "totalDependentesAtivos",
  consulted_at as "dataConsulta",
  collected_at as "collectedAt"
`;

export async function getLatestActiveLivesSnapshot() {
  const result = await dbQuery<SnapshotRow>(
    `select ${SNAPSHOT_SELECT}
       from active_lives_snapshots
      order by collected_at desc, id desc
      limit 1`
  );
  return result.rows[0] ? serializeSnapshot(result.rows[0]) : null;
}

export async function collectActiveLives(options: { force?: boolean } = {}) {
  const latest = await getLatestActiveLivesSnapshot();
  if (!options.force && latest) {
    const ageMs = Date.now() - new Date(latest.collectedAt).getTime();
    if (ageMs >= 0 && ageMs < ACTIVE_LIVES_COLLECTION_INTERVAL_MS - 5_000) {
      return { snapshot: latest, collected: false, reason: "fresh" as const };
    }
  }

  const payload = await fetchActiveLives();
  const collectionSlot = Math.floor(Date.now() / ACTIVE_LIVES_COLLECTION_INTERVAL_MS);
  const result = await dbQuery<SnapshotRow>(
    `insert into active_lives_snapshots (
       collection_slot,
       total_active_lives,
       total_active_holders,
       total_active_dependents,
       consulted_at,
       collected_at
     ) values ($1, $2, $3, $4, $5::timestamptz, now())
     on conflict (collection_slot) do update set
       total_active_lives = excluded.total_active_lives,
       total_active_holders = excluded.total_active_holders,
       total_active_dependents = excluded.total_active_dependents,
       consulted_at = excluded.consulted_at,
       collected_at = now()
     returning ${SNAPSHOT_SELECT}`,
    [
      collectionSlot,
      payload.totalVidasAtivas,
      payload.totalTitularesAtivos,
      payload.totalDependentesAtivos,
      payload.dataConsulta
    ]
  );

  return {
    snapshot: serializeSnapshot(result.rows[0]),
    collected: true,
    reason: options.force ? ("manual" as const) : ("due" as const)
  };
}

function emptyGrowth(): ActiveLivesGrowth {
  return { absolute: 0, percentage: null };
}

function growth(first: number | undefined, last: number | undefined): ActiveLivesGrowth {
  if (first === undefined || last === undefined) return emptyGrowth();
  const absolute = last - first;
  return {
    absolute,
    percentage: first === 0 ? null : (absolute / first) * 100
  };
}

export async function getActiveLivesDashboard(from: string, to: string): Promise<ActiveLivesDashboardData> {
  const fromDate = new Date(`${from}T00:00:00${FORTALEZA_OFFSET}`);
  const toDate = new Date(`${to}T00:00:00${FORTALEZA_OFFSET}`);
  const toExclusive = new Date(toDate.getTime() + 86_400_000);
  const days = Math.max(1, Math.round((toDate.getTime() - fromDate.getTime()) / 86_400_000) + 1);
  const sampling: "hour" | "day" = days <= 3 ? "hour" : "day";
  const bucketExpression = sampling === "hour"
    ? `date_trunc('hour', consulted_at at time zone 'America/Fortaleza')`
    : `date_trunc('day', consulted_at at time zone 'America/Fortaleza')`;
  const rangeValues = [fromDate.toISOString(), toExclusive.toISOString()];

  const [latest, boundaries, trendResult] = await Promise.all([
    getLatestActiveLivesSnapshot(),
    dbQuery<SnapshotRow>(
      `(
         select ${SNAPSHOT_SELECT}
           from active_lives_snapshots
          where consulted_at >= $1::timestamptz
            and consulted_at < $2::timestamptz
          order by consulted_at asc, id asc
          limit 1
       )
       union all
       (
         select ${SNAPSHOT_SELECT}
           from active_lives_snapshots
          where consulted_at >= $1::timestamptz
            and consulted_at < $2::timestamptz
          order by consulted_at desc, id desc
          limit 1
       )`,
      rangeValues
    ),
    dbQuery<SnapshotRow>(
      `with ranked as (
         select
           ${SNAPSHOT_SELECT},
           row_number() over (
             partition by ${bucketExpression}
             order by consulted_at desc, id desc
           ) as rn
         from active_lives_snapshots
         where consulted_at >= $1::timestamptz
           and consulted_at < $2::timestamptz
       )
       select id, "totalVidasAtivas", "totalTitularesAtivos", "totalDependentesAtivos", "dataConsulta", "collectedAt"
         from ranked
        where rn = 1
        order by "dataConsulta" asc`,
      rangeValues
    )
  ]);

  const first = boundaries.rows[0] ? serializeSnapshot(boundaries.rows[0]) : null;
  const last = boundaries.rows[1] ? serializeSnapshot(boundaries.rows[1]) : first;

  return {
    latest,
    period: {
      from,
      to,
      first,
      last,
      growth: {
        totalVidasAtivas: growth(first?.totalVidasAtivas, last?.totalVidasAtivas),
        totalTitularesAtivos: growth(first?.totalTitularesAtivos, last?.totalTitularesAtivos),
        totalDependentesAtivos: growth(first?.totalDependentesAtivos, last?.totalDependentesAtivos)
      }
    },
    trend: trendResult.rows.map(serializeSnapshot),
    sampling,
    collectionIntervalMinutes: 5
  };
}

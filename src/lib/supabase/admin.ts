import { createClient } from "@supabase/supabase-js";

function createDisabledEventLogsQuery() {
  const result = { data: [] as unknown[], error: null };
  const singleResult = { data: null, error: null };
  const builder: Record<string, unknown> & PromiseLike<typeof result> = {
    insert: async () => ({ data: null, error: null }),
    update: async () => ({ data: null, error: null }),
    delete: async () => ({ data: null, error: null }),
    select: () => builder,
    eq: () => builder,
    neq: () => builder,
    gte: () => builder,
    lte: () => builder,
    in: () => builder,
    is: () => builder,
    order: () => builder,
    limit: () => builder,
    maybeSingle: async () => singleResult,
    single: async () => singleResult,
    then: (onfulfilled, onrejected) => Promise.resolve(result).then(onfulfilled, onrejected)
  };
  return builder;
}

export function createSupabaseAdminClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("Supabase admin não configurado.");

  const client = createClient(url, key, { auth: { persistSession: false } });

  // event_logs existia apenas para a fase inicial de observabilidade. O guard
  // impede que qualquer chamada legada volte a consultar ou gravar esse objeto
  // no Supabase enquanto os pontos antigos sao eliminados do codigo.
  return new Proxy(client, {
    get(target, property, receiver) {
      if (property === "from") {
        return (relation: string) => {
          if (relation === "event_logs") return createDisabledEventLogsQuery();
          return target.from(relation);
        };
      }

      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    }
  }) as typeof client;
}

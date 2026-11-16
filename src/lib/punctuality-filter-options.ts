/** Uma opção por entidade real (ID), sem usar rótulos agregados como identidade.
 * Vírgulas no nome original de uma campanha ou lote são texto, nunca separadores.
 * Preserva a primeira ocorrência e a ordem fornecida pelo banco.
 */
export type PunctualityFilterOption = { value: string; label: string };

export function uniqueOptionsByValue<T extends PunctualityFilterOption>(options: readonly T[]): T[] {
  const seen = new Set<string>();
  return options.filter((option) => {
    const id = option.value.trim();
    if (!id || seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

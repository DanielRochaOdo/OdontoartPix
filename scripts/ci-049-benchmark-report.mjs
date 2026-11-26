// CI-only evidence extraction for the 049-B query benchmark.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
assert.equal(process.env.CI, 'true');
assert.equal(process.env.GITHUB_ACTIONS, 'true');
const log = (await readFile('benchmark-049/test.log', 'utf8')).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '');
const marker = '[049_B_QUERY_BENCHMARK] ';
const matches = log.split(/\r?\n/).filter(line => line.includes(marker));
assert.equal(matches.length, 1, 'Expected exactly one benchmark report');
const report = JSON.parse(matches[0].slice(matches[0].indexOf(marker) + marker.length));
assert.equal(report.canonical, 78293);
assert.equal(report.links, 20014);
assert.equal(report.results.length, 8);
function median(values) {
  const a = [...values].sort((x,y) => x-y);
  return (a[1]+a[2])/2;
}
const on=report.results.filter(r=>r.mode==='on'), off=report.results.filter(r=>r.mode==='off');
assert.equal(on.length,4); assert.equal(off.length,4);
assert.ok(report.results.every(r=>Number.isFinite(r.executionMs) && r.executionMs>0));
assert.ok(off.every(r=>!r.jitPresent));
const medianOnMs=median(on.map(r=>r.executionMs)), medianOffMs=median(off.map(r=>r.executionMs));
const summary={...report, medianOnMs, medianOffMs, reductionPct:100*(1-medianOffMs/medianOnMs), speedup:medianOnMs/medianOffMs, jitObservedOn:on.filter(r=>r.jitPresent).length, scopeLimit:'Query-only simplified temporary fixtures; no full-worker or pre-046 comparison; no performance threshold enforced.'};
await writeFile('benchmark-049/results.json',JSON.stringify(summary,null,2)+'\n');
const markdown=['## 049-B: benchmark da consulta parametrizada','', '| Modo | Mediana (ms) |','|---|---:|', '| JIT on | '+medianOnMs.toFixed(3)+' |','| JIT off | '+medianOffMs.toFixed(3)+' |','','Reducao observada: '+summary.reductionPct.toFixed(2)+'%; fator: '+summary.speedup.toFixed(2)+'x. JIT observado em '+summary.jitObservedOn+'/4 execucoes on.','', summary.scopeLimit,''].join('\n');
if(process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, markdown, {flag:'a'});
console.log(JSON.stringify(summary));

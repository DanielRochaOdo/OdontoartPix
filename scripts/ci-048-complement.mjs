// Additional operational cases; invoked only by the isolated CI harness.
// No source changes, no real ERP, no production credentials.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';

export async function runComplement(ctx) {
  const {client,dbConfig,origin,cookie,scenario,f,start,worker,verify,audit,record,sleep,server}=ctx;
  const cases=['delete-after-lock','delete-before-lock-047','delete-before-lock-048','delete-campaign-before-lock-047','delete-campaign-before-lock-048','delete-legacy-before-lock-048','import','cancel'];
  assert(cases.includes(scenario));
  assert.equal(process.env.GITHUB_ACTIONS,'true');
  assert.equal(dbConfig.database,'odontoart_pix_ops048');
  const baseRoute='/api/dashboard/general-sync/';
  const request=async(route,method='POST',body={})=>{
    const isForm=body instanceof FormData;
    const response=await fetch(origin+route,{method,headers:{cookie,...(isForm?{}:{'Content-Type':'application/json'})},
      body:method==='DELETE'||method==='GET'?undefined:isForm?body:JSON.stringify(body),signal:AbortSignal.timeout(90000)});
    return {status:response.status,body:await response.json()};
  };
  const deadlocks=async()=>{
    await client.query("select pg_stat_clear_snapshot()");
    return (await client.query("select deadlocks::int n from pg_stat_database where datname=current_database()")).rows[0].n;
  };
  const beforeDeadlocks=await deadlocks();
  const external=async(copy)=>{
    const campaign=randomUUID(), batch=randomUUID();
    await client.query("insert into campaigns(id,name,status) values($1,$2,'rascunho')",[campaign,'Complement '+scenario]);
    await client.query("insert into campaign_batches(id,campaign_id,name) values($1,$2,'Complement lot')",[batch,campaign]);
    if(copy)await client.query("insert into campaign_batch_members(campaign_id,batch_id,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,processing_status) select $1,$2,member_id,target_installment_id,installment_amount_cents,payment_status,payment_status_source,total_pending_amount_cents,'completed' from campaign_batch_members where batch_id=$3 and deleted_at is null",[campaign,batch,f.batches[0]]);
    await client.query("select public.recalculate_batch_totals_many(array[$1::uuid])",[batch]);
    return {campaign,batch};
  };
  const readTargets=async()=> (await client.query("select t.id,t.amount_cents,t.paid_amount_cents,t.pending_amount_cents,t.payment_status,t.payment_status_source from member_target_installments t join members m on m.id=t.member_id where m.cpf_hash like $1 order by t.id",[f.tag+':%'])).rows;
  async function gated(table, action) {
    assert(['grouped_incremental_totals_pending','grouped_batch_totals_pending'].includes(table));
    const key='202611250482';
    const locker=new pg.Client(dbConfig);await locker.connect();
    let work, other, outcome, response, evidence={table};
    await client.query("create function public.ci048_complement_gate() returns trigger language plpgsql as $$ begin perform pg_advisory_xact_lock(202611250482::bigint); return new; end; $$");
    await client.query("create trigger ci048_complement_gate before insert on public."+table+" for each row execute function public.ci048_complement_gate()");
    try{
      await locker.query("select pg_advisory_lock($1::bigint)",[key]);
      const lockPid=(await locker.query("select pg_backend_pid() pid")).rows[0].pid;
      work=worker('complement-'+scenario).then(value=>({value}),error=>({error:String(error)}));
      let workerPid;
      for(let i=0;i<600;i++){
        workerPid=(await client.query("select pid from pg_stat_activity where datname=current_database() and application_name='ci048-worker' and $1::int=any(pg_blocking_pids(pid))",[lockPid])).rows[0]?.pid;
        if(workerPid)break;
        await sleep(50);
      }
      assert.ok(workerPid,'Real worker must be blocked at test gate');
      evidence.workerPid=workerPid;
      async function overlap(promise, allowEarly=false) {
        let early;
        other=promise.then(value=>{early=value;return value;},error=>{early={error:String(error)};return early;});
        for(let i=0;i<600;i++){
          const rows=(await client.query("select pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) blockers from pg_stat_activity where datname=current_database() and application_name='ci048-api' and $1::int=any(pg_blocking_pids(pid))",[workerPid])).rows;
          if(rows.length){evidence.apiWait=rows;return;}
          if(early){if(allowEarly&&!early.error){evidence.apiCompletedWhileGated=true;return;}throw Error('API returned before required lock wait: '+JSON.stringify(early));}
          await sleep(50);
        }
        throw Error('API did not wait on real worker');
      }
      await action({overlap,evidence,workerPid});
      await locker.query("select pg_advisory_unlock($1::bigint)",[key]);
      if(other)response=await other;
      outcome=await work;
    }finally{
      await locker.end();
      if(other)await other;
      if(work)await work;
      await client.query("drop trigger ci048_complement_gate on public."+table);
      await client.query("drop function public.ci048_complement_gate()");
    }
    evidence.response=response;evidence.worker=outcome;evidence.deadlocks=(await deadlocks())-beforeDeadlocks;
    console.log('[048_COMPLEMENT_LOCK_EVIDENCE]',JSON.stringify(evidence));
    return evidence;
  }
  if(scenario.startsWith('delete-')){
    const ext=await external(true);
    const before=await readTargets();
    const reverse=scenario.includes('before');
    // Compare the existing 047 lock order to 048 under the SAME controlled race.
    if(scenario.endsWith('047'))await client.query("select public.set_grouped_incremental_totals_v1(false)");
    const id=await start(f);
    const route=scenario.includes('campaign')?'/api/campanhas/'+ext.campaign:
      scenario.includes('legacy')?'/api/lotes/'+ext.batch+'/excluir':'/api/lotes/'+ext.batch;
    const inspect=async()=> (await client.query("select (select count(*)::int from campaigns where id=$2) campaigns,(select count(*)::int from campaign_batches where id=$1) batches,(select count(*)::int from campaign_batch_members where batch_id=$1) links,(select count(*)::int from batch_totals_shadow_contributions where batch_id=$1) contributions,(select count(*)::int from batch_totals_shadow_totals where batch_id=$1) totals",[ext.batch,ext.campaign])).rows[0];
    const initial=await inspect();
    const e=await gated(reverse?'grouped_batch_totals_pending':'grouped_incremental_totals_pending',async({evidence})=>{
      // The worker is genuinely gated inside a transaction. The new guard
      // must reject before any parent/child row locks, not wait for the gate.
      const blocked=await request(route,'DELETE');
      evidence.busyResponse=blocked;
      assert.equal(blocked.status,409,JSON.stringify(blocked));
      assert.equal(blocked.body.success,false);
      assert.equal(blocked.body.error.code,'PROCESSING_CONFLICT');
      assert.deepEqual(await inspect(),initial,'Busy deletion must not change any row or contribution');
    });
    assert.equal(e.deadlocks,0,'Busy request must not deadlock');
    assert.ok(!e.worker?.error,JSON.stringify(e.worker));
    // Retry only after the real worker exits, with the same target and route.
    await audit('before idle deletion retry');
    const response=await request(route,'DELETE');
    e.response=response;
    // Save audit details before assertions, without repairing official totals.
    const after=await readTargets();
    const run=await request(baseRoute+id,'GET');
    const residue=await inspect();
    const diffs=(await client.query("select * from public.batch_totals_shadow_audit_v1 where official_differs or shadow_differs or orphan_batch")).rows;
    console.log('[048_COMPLEMENT_DELETE]',JSON.stringify({scenario,e,residue,run:run.body?.data?.status,diffs,canonicalBefore:before.length,canonicalAfter:after.length}));
    assert.equal(e.deadlocks,0,'Concurrent deletion caused a deadlock');
    assert.equal(e.response?.status,200,JSON.stringify(e.response));
    assert.equal(e.response.body.success,true);
    assert.ok(!e.worker?.error,JSON.stringify(e.worker));
    assert.deepEqual(residue,{campaigns:scenario.includes('campaign')?0:1,batches:0,links:0,contributions:0,totals:0});
    assert.equal((await request(route,'DELETE')).status,404,'Idle retry on deleted ID must report not found');
    assert.deepEqual(after.map(r=>r.id),before.map(r=>r.id),'Canonical IDs must survive cascade');
    await record(scenario,{...await verify(f,id,f.size),lockEvidence:e,residue});
  }else if(scenario==='import'){
    const ext=await external(false);
    const initial=await readTargets();
    const id=await start(f);
    let selected;
    const e=await gated('grouped_incremental_totals_pending',async({overlap,workerPid,evidence})=>{
      // Find a canonical row demonstrably locked by the in-flight worker.
      const rows=(await client.query("select t.id,m.external_user_code code,t.external_installment_code installment from member_target_installments t join members m on m.id=t.member_id where m.cpf_hash like $1 order by t.id",[f.tag+':%'])).rows;
      const probe=new pg.Client(dbConfig);await probe.connect();
      try{
        for(const r of rows){
          await probe.query('begin');
          try{await probe.query("select id from member_target_installments where id=$1 for no key update nowait",[r.id]);}
          catch(error){if(error.code!=='55P03')throw error;selected=r;}
          finally{await probe.query('rollback');}
          if(selected)break;
        }
      }finally{await probe.end();}
      assert.ok(selected,'Must import a canonical row locked by worker');
      evidence.selected=selected.id;
      const form=new FormData();
      form.set('campaignId',ext.campaign);form.set('batchId',ext.batch);
      form.set('file',new Blob(['Synthetic;'+selected.code+';'+selected.installment+';999.00;00000000000;2026-11-18;Clinico\n'],{type:'text/plain'}),'synthetic.txt');
      await overlap(request('/api/campanhas/importar-v2','POST',form));
    });
    assert.equal(e.deadlocks,0);
    assert.ok(e.response?.status>=200&&e.response?.status<300&&e.response?.body.success,JSON.stringify(e.response));
    assert.ok(!e.worker?.error,JSON.stringify(e.worker));
    const imported=(await client.query("select b.target_installment_ref_id,b.installment_amount_cents,b.total_pending_amount_cents,b.payment_status,t.amount_cents,t.pending_amount_cents,t.payment_status canonical_status from campaign_batch_members b join member_target_installments t on t.id=b.target_installment_ref_id where b.batch_id=$1 and b.deleted_at is null",[ext.batch])).rows;
    assert.equal(imported.length,1);
    assert.equal(imported[0].target_installment_ref_id,selected.id);
    assert.equal(imported[0].amount_cents,'10000','Import must not overwrite canonical ERP amount');
    assert.equal(imported[0].installment_amount_cents,imported[0].amount_cents);
    assert.equal(imported[0].total_pending_amount_cents,imported[0].pending_amount_cents);
    assert.equal(imported[0].payment_status,imported[0].canonical_status);
    assert.deepEqual((await readTargets()).map(r=>r.id),initial.map(r=>r.id));
    await record('concurrent HTTP import of shared canonical',{...await verify(f,id,f.size),lockEvidence:e,imported});
  }else{
    const id=await start(f);
    const e=await gated('grouped_incremental_totals_pending',async({overlap,evidence})=>{
      const pause=await request(baseRoute+id+'/pause');
      assert.equal(pause.status,410,'Current contract forbids new pauses');
      evidence.pause=pause.status;
      // Launch cancellation, observe its wait (or valid early response),
      // then release the worker gate BEFORE awaiting the HTTP response.
      await overlap(request(baseRoute+id+'/cancel','POST',{reason:'CI048 cancel while grouped commit pending'}),true);
    });
    assert.equal(e.deadlocks,0);
    assert.ok(!e.worker?.error,JSON.stringify(e.worker));
    assert.equal(e.response?.status,202,JSON.stringify(e.response));
    assert.equal(e.response.body.success,true);
    assert.ok(['cancelling','cancelled'].includes(e.response.body.data.status),JSON.stringify(e.response));
    assert.equal((await request(baseRoute+id+'/resume')).status,409,'Cancellation is definitive');
    let result;
    for(let i=0;i<5;i++){
      result=(await request(baseRoute+id,'GET')).body.data;
      if(result.status==='cancelled')break;
      await worker('complete-cancellation-'+i);
    }
    assert.equal(result.status,'cancelled',JSON.stringify(result));
    assert(result.successCount>0,'At least one grouped result must survive');
    assert.equal(result.errorCount,0);
    const snapshot=await readTargets();
    const terminal=snapshot.filter(r=>['paid','agreed','excluded'].includes(r.payment_status));
    assert(terminal.length>0,'Committed terminal payments must survive');
    assert.equal((await request(baseRoute+id+'/resume')).status,409);
    // No repair before this audit. A stale operational total is a real finding.
    await record('pause rejected, active cancellation preserves committed results',{status:'cancelled',runId:id,successCount:result.successCount,lockEvidence:e,terminalCount:terminal.length});
    const newId=await start(f);
    await worker('new-run-after-cancel');
    const completed=(await request(baseRoute+newId,'GET')).body.data;
    assert.equal(completed.status,'completed');
    assert.equal(completed.errorCount,0);
    const final=await readTargets();
    for(const row of terminal)assert.deepEqual(final.find(r=>r.id===row.id),row,'Terminal canonical changed on new run');
    const counts=Object.fromEntries(['paid','unpaid','agreed','excluded'].map(status=>[status,final.filter(r=>r.payment_status===status).length]));
    assert.deepEqual(counts,{paid:f.size*2/5,unpaid:f.size/5,agreed:f.size/5,excluded:f.size/5});
    assert.equal(final.length,f.size);
    assert.equal(final.reduce((n,r)=>n+BigInt(r.pending_amount_cents),0n),BigInt(f.size/5)*14000n);
    assert.equal(final.reduce((n,r)=>n+BigInt(r.paid_amount_cents),0n),BigInt(f.size/5)*16000n);
    await record('new synchronization after definitive cancellation',{status:'completed',runId:newId,terminalPreserved:terminal.length,counts});
  }
}

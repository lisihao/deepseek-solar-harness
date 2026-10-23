import assert from 'node:assert/strict'
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
import test from 'node:test'
import {Ledger} from '../rlm-arc-pilot/ledger.mjs'
import {RECOVERY_POLICY,recoveryBudget,validatePrefix,claimRecovery,sanitizeGrade,inspectRecoveryClaim} from './recovery.mjs'
const prefix=()=>({kind:'quality-three-arm-final-receipt-v1',accounting:{cumulative:{admitted:589,confirmed:575,unknown:14,cap:600,withinCap:true},new:{admitted:65,confirmed:65,unknown:0,physicalAdmitted:65}},closes:{provider:'closed',relay:'closed',networkProfile:'disposed',longReadProfile:'closed'},error:null,results:[{cleanupComplete:true},{cleanupComplete:true},{cleanupComplete:true}]})
test('recovery requires the fully closed actual 589 prefix and retains fourteen unknown',()=>{
 assert.deepEqual(validatePrefix(prefix()),{charged:589,confirmed:575,unknown:14})
 for(const change of [r=>r.accounting.cumulative.admitted--,r=>r.accounting.cumulative.unknown=0,r=>r.closes.provider='failed',r=>r.results[1].cleanupComplete=false]){const r=prefix();change(r);assert.throws(()=>validatePrefix(r))}
})
test('recovery admits only eleven same-tree logical and physical requests, then blocks 601',async()=>{
 const d=await mkdtemp(join(tmpdir(),'quality-recovery-budget-'))
 try{
  const base=await Ledger.open(join(d,'ledger.jsonl'),{total:11,perRun:11}),b=recoveryBudget(base)
  await assert.rejects(()=>b.admit('R32',{}),/unexpected recovery arm/)
  for(let i=0;i<11;i++){const id=await b.admit('S11',{ordinal:i});b.admitPhysical({runId:'S11',logicalRequest:id,event:{synthetic:true}});await b.settle(id,[{type:'finish',reason:{kind:'stop'}}],null)}
  await assert.rejects(()=>b.admit('S11',{}),/600 cumulative/)
  assert.throws(()=>b.admitPhysical({runId:'S11',logicalRequest:'extra',event:{}}),/600 physical/)
  const r=await b.receipt();assert.equal(r.cumulativeAdmitted,600);assert.equal(r.cumulativeConfirmed,586);assert.equal(r.cumulativeUnknown,14)
 }finally{await rm(d,{recursive:true,force:true})}
})
test('recovery strategy describes native turn-boundary timing without benchmark labels',()=>{
 assert.match(RECOVERY_POLICY,/parent assistant turn ends/);assert.match(RECOVERY_POLICY,/at most TWO children/);assert.match(RECOVERY_POLICY,/ELEVEN model requests/);assert.doesNotMatch(RECOVERY_POLICY,/Answer:\s*\d+|gold|benchmark answer/)
})

test('a second output cannot reuse the same actual spending prefix',async()=>{
 const d=await mkdtemp(join(tmpdir(),'quality-recovery-claim-'))
 try{await mkdir(join(d,'first'));await mkdir(join(d,'second'));await claimRecovery(join(d,'prior.json'),join(d,'first'),'fingerprint');await assert.rejects(()=>claimRecovery(join(d,'prior.json'),join(d,'second'),'other'),{code:'EEXIST'})}finally{await rm(d,{recursive:true,force:true})}
})

test('public receipt grading omits gold and the raw upstream scorer payload',()=>{
 assert.deepEqual(sanitizeGrade({score:0.5,exact:false,attemptedParse:'candidate-value',gold:'private-reference-value',official:{answer:'private-reference-value',context:'private'}}),{score:0.5,exact:false,attemptedParse:'candidate-value'})
})

test('a partial allocation is reconciled as owned without inventing a real-start marker',async()=>{
 const d=await mkdtemp(join(tmpdir(),'quality-recovery-partial-'))
 try{const output=join(d,'output');await mkdir(output);await writeFile(join(d,'quality-recovery-v1-allocation.json'),JSON.stringify({output,fingerprint:'bound'}));assert.deepEqual(await inspectRecoveryClaim(join(d,'prior.json'),output,'bound'),{allocationOwned:true,realStartMarked:false})}finally{await rm(d,{recursive:true,force:true})}
})

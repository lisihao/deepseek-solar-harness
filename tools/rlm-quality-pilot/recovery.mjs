#!/opt/homebrew/opt/node@22/bin/node
// One exploratory, same-question recovery. No automatic retry or resampling.
import assert from 'node:assert/strict'
import {execFileSync} from 'node:child_process'
import {createHash} from 'node:crypto'
import {copyFile,mkdir,readFile,readdir,symlink,writeFile} from 'node:fs/promises'
import {dirname,join,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {compileCurrentSources,prepareSharedRuntime,loadRealProvider} from '../rlm-arc-pilot/run.mjs'
import {createAttachmentRelay} from '../rlm-arc-pilot/attachment-relay.mjs'
import {Ledger} from '../rlm-arc-pilot/ledger.mjs'
import {executeCondition} from '../rlm-recursion-pilot/run.mjs'
import {prepareFixture,createSyntheticProvider,gradeFixture} from '../rlm-recursion-pilot/native-acceptance.mjs'
import {createLongReadProfile} from './long-read.mjs'
import {installNoReuseProfile} from '../rlm-recursion-pilot/network-profile.mjs'
import {loadTask,gradeTask} from './task.mjs'
import {FIXED_GUIDANCE,FIXED_ROUTE,REQUIRED_SOURCE_FILES} from './three-arm.mjs'
const ROOT=resolve(dirname(fileURLToPath(import.meta.url)),'../..')
const sha=x=>createHash('sha256').update(x).digest('hex')
const json=async p=>JSON.parse(await readFile(p,'utf8'))
const hash=async p=>sha(await readFile(p))
const save=async(p,x)=>writeFile(p,JSON.stringify(x,null,2)+'\n',{flag:'wx',mode:0o600})
const head=()=>execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8'}).trim()
export const RECOVERY_POLICY='Operational recovery policy: Prime defers a newly spawned child task until the parent assistant turn ends. Put the complete assignment and classification rules in each initial spawn prompt. Do not send agent_message follow-ups or corrections to a child before it has settled. After spawning at most TWO children on disjoint batches, end the current assistant turn with a brief waiting message; do not keep that turn open by collecting, polling, or classifying more records. Let native child-exit notifications resume you, then collect settled results. Each child must classify every assigned record explicitly and save its own labels. Verify complete, non-overlapping record coverage and compute the final target count with Python. The entire tree has at most ELEVEN model requests; write the final answer within that limit.'
export function validatePrefix(r){
 assert.equal(r.kind,'quality-three-arm-final-receipt-v1')
 assert.deepEqual(r.accounting.cumulative,{admitted:589,confirmed:575,unknown:14,cap:600,withinCap:true})
 assert.deepEqual(r.accounting.new,{admitted:65,confirmed:65,unknown:0,physicalAdmitted:65})
 assert.deepEqual(r.closes,{provider:'closed',relay:'closed',networkProfile:'disposed',longReadProfile:'closed'})
 assert.equal(r.error,null);assert.equal(r.results.length,3)
 assert.ok(r.results.every(x=>x.cleanupComplete===true))
 return {charged:589,confirmed:575,unknown:14}
}
export function recoveryBudget(base){
 assert.equal(base.total,11);assert.equal(base.perRun,11);assert.equal(base.priorAdmitted,0)
 const check=id=>{assert.equal(id,'S11','unexpected recovery arm');assert.ok(base.calls.size<11,'600 cumulative request ceiling reached')}
 return {async admit(id,request){check(id);return base.admit(id,request)},admitPhysical(x){assert.equal(x.runId,'S11');assert.ok(base.physicalAdmissions<11,'600 physical request ceiling reached');return base.admitPhysical(x)},settle(...x){return base.settle(...x)},appendSync(...x){return base.appendSync(...x)},get stopped(){return base.stopped},get calls(){return base.calls},get physicalByRun(){return base.physicalByRun},async receipt(){const r=await base.receipt();return {...r,cumulativeAdmitted:589+r.newAdmitted,cumulativeConfirmed:575+r.settled,cumulativeUnknown:14+r.unknown}}}
}
async function sourceHashes(){
 const files=[...REQUIRED_SOURCE_FILES,'tools/rlm-quality-pilot/recovery.mjs','package.json','pnpm-lock.yaml','incubator/rlm/package.json','incubator/rlm/assets/runtime-manifest.json']
 for(const f of await readdir(join(ROOT,'incubator/rlm/src')))if(f.endsWith('.ts'))files.push('incubator/rlm/src/'+f)
 const result={};for(const f of files)result[f]=await hash(join(ROOT,f));return result
}
async function verify(m){
 const {fingerprint,...unsigned}=m;assert.equal(sha(JSON.stringify(unsigned)),fingerprint,'manifest fingerprint changed')
 assert.equal(head(),m.sourceHead,'source HEAD changed')
 assert.deepEqual(await sourceHashes(),m.sourceHashes,'bound source bytes changed')
 assert.equal(await hash(m.prior.path),m.prior.sha256);validatePrefix(await json(m.prior.path))
 assert.equal(await hash(m.prior.verificationPath),m.prior.verificationSha256);const priorVerification=await json(m.prior.verificationPath);assert.deepEqual(priorVerification.mismatches,[]);assert.equal(priorVerification.checks.processAndSocketPassed,true)
 assert.equal(await hash(m.task.path),m.task.sha256)
 for(const [f,v] of Object.entries(m.shared.compiled.outputs))assert.equal(await hash(join(m.shared.compiled.path,f)),v.sha256)
 assert.equal(await hash(m.shared.worker.path),m.shared.worker.sha256)
 assert.equal(await hash(join(m.condition.workspace,'inputs/context.txt')),m.task.contextSha256)
 assert.equal(sha(m.condition.prompt.task),m.promptSha256)
 const task=await loadTask(m.task.path);assert.equal(task.id,m.task.id);return task
}
export async function prepareRecovery({output,tmpRoot,prior,taskPath}){
 for(const p of [output,tmpRoot,prior,taskPath])assert.equal(resolve(p),p)
 assert.ok(tmpRoot.startsWith('/private/tmp/')&&tmpRoot.length<24)
 const prefix=validatePrefix(await json(prior));const verificationPath=join(dirname(prior),'parent-private/independent-verification.json');const priorVerification=await json(verificationPath);assert.deepEqual(priorVerification.mismatches,[]);assert.equal(priorVerification.checks.processAndSocketPassed,true);const task=await loadTask(taskPath)
 assert.equal(task.id,'oolong-trec-32k-15000243');assert.equal(sha(task.context),'64e3a042daf4bf66fbbb8b59d0a008179d5d4ce4a1554d7bcc11eba7f2204150')
 await mkdir(output,{mode:0o700});await mkdir(tmpRoot,{mode:0o700})
 const shared=join(tmpRoot,'shared');await mkdir(shared,{mode:0o700})
 const packageRoot=join(ROOT,'incubator/rlm')
 const compiled=await compileCurrentSources({sourceRoot:ROOT,packageRoot,shared})
 const runtime=await prepareSharedRuntime({compiled:compiled.compiled,packageRoot,shared})
 const workerPath=join(shared,'worker.mjs');await copyFile(join(ROOT,'tools/rlm-arc-pilot/native-worker.mjs'),workerPath)
 const runDirectory=join(tmpRoot,'runs/S11'),workspace=join(runDirectory,'workspace'),durableDirectory=join(output,'runs/S11')
 for(const d of [join(workspace,'inputs'),join(runDirectory,'data'),join(runDirectory,'home'),join(runDirectory,'tmp'),join(runDirectory,'client-state'),join(durableDirectory,'parent-intents'),join(output,'parent-private')])await mkdir(d,{recursive:true,mode:0o700})
 await symlink(runtime.runtimes,join(runDirectory,'data/runtimes'),'dir')
 await writeFile(join(workspace,'inputs/context.txt'),task.context,{flag:'wx',mode:0o400})
 const prompt=['Read inputs/context.txt as the complete provided context.',FIXED_GUIDANCE,RECOVERY_POLICY,task.question,'JSON-encode the final Answer string and write it to answer.json. The file must contain one JSON string, not an object.'].join('\n\n')
 const condition={id:'S11',arm:'S',protocol:'quality-recovery-v1',taskId:task.id,runDirectory,workspace,data:join(runDirectory,'data'),durableDirectory,prompt:{task:prompt},inputHashes:{'inputs/context.txt':sha(task.context)},autonomous:{maxTurns:11,maxTokens:4_000_000,gate:'test -s answer.json'}}
 const m={formatVersion:1,kind:'quality-recovery-prepared-v1',createdAt:new Date().toISOString(),sourceHead:head(),sourceHashes:await sourceHashes(),output,tmpRoot,parentPrivate:join(output,'parent-private'),runner:{sourceRoot:ROOT},package:{root:packageRoot},shared:{path:shared,compiled:{path:compiled.compiled,outputs:compiled.outputs,hash:compiled.hash},runtime,worker:{path:workerPath,sha256:await hash(workerPath)}},prior:{path:prior,sha256:await hash(prior),accounting:prefix,verificationPath,verificationSha256:await hash(verificationPath)},task:{path:taskPath,sha256:await hash(taskPath),contextSha256:sha(task.context),id:task.id},route:FIXED_ROUTE,condition,promptSha256:sha(prompt),limits:{requests:11,global:600},strategyAdaptation:true,strategyInstructionsOnly:true,noRealProviderLoaded:true}
 m.fingerprint=sha(JSON.stringify(m));await save(join(output,'prepared.json'),m);return m
}
export async function acceptRecovery(output){
 const m=await json(join(output,'prepared.json'));await verify(m)
 const f=await prepareFixture({sourceRoot:ROOT,shared:m.shared.path,tempRoot:join(m.tmpRoot,'keyless'),artifactRoot:join(output,'parent-private/keyless'),arm:'S'})
 const condition={...f.condition,id:'keyless-S11',arm:'S',protocol:'quality-recovery-v1',autonomous:m.condition.autonomous}
 const ledger=await Ledger.open(join(f.condition.durableDirectory,'ledger.jsonl'),{total:11,perRun:11})
 const fixture=createSyntheticProvider({arm:'S',fixture:f.fixture});let outcome
 try{outcome=await executeCondition({manifest:{...m,parentPrivate:f.parentPrivate},condition,provider:fixture.provider,ledger,relay:{async restoreOptions(o){return o}},task:f.task,grade:gradeFixture,protectedRoots:[f.protectedCanaryRoot]})}finally{await fixture.provider.close()}
 await save(join(output,'parent-private/native-outcome.json'),outcome)
 assert.equal(outcome.executionCompleted,true);assert.equal(outcome.cleanupComplete,true);assert.equal(outcome.worker.requests,8)
 assert.equal(outcome.worker.nativeDepth,1);assert.equal(outcome.worker.actualDepth,1);assert.equal(outcome.observed.childModelRequestCount,3);assert.equal(outcome.grading.primaryScore,1)
 await verify(m)
 const proof={formatVersion:1,kind:'quality-recovery-native-proof-v1',fingerprint:m.fingerprint,preparedSha256:await hash(join(output,'prepared.json')),realModelRequests:0,noCredentialsOrRealProviderLoaded:true,accepted:true,qualityModelAdherenceVerified:false,limits:{parent:11,native:11},provider:fixture.stats(),outcomeSha256:await hash(join(output,'parent-private/native-outcome.json'))}
 await save(join(output,'accepted.json'),proof);return proof
}
export function sanitizeGrade(fullGrade){const {gold,official,...safe}=fullGrade;return safe}
export async function claimRecovery(prior,output,fingerprint){
 await save(join(dirname(prior),'quality-recovery-v1-allocation.json'),{output,fingerprint,prefix:589,cap:600})
 await save(join(output,'real-run-started.json'),{time:new Date().toISOString(),fingerprint})
}
export async function inspectRecoveryClaim(prior,output,fingerprint){
 const read=async p=>{try{return await json(p)}catch(e){if(e.code==='ENOENT')return null;throw e}}
 const allocation=await read(join(dirname(prior),'quality-recovery-v1-allocation.json')),start=await read(join(output,'real-run-started.json'))
 return {allocationOwned:allocation?.output===output&&allocation?.fingerprint===fingerprint,realStartMarked:start?.fingerprint===fingerprint}
}
export async function runRecovery({output,providerModule,providerSha256,providerPackage,credentialFile}){
 const m=await json(join(output,'prepared.json'));const task=await verify(m)
 const proof=await json(join(output,'accepted.json'));assert.equal(proof.accepted,true);assert.equal(proof.fingerprint,m.fingerprint);assert.equal(proof.realModelRequests,0);assert.equal(proof.preparedSha256,await hash(join(output,'prepared.json')));assert.equal(proof.outcomeSha256,await hash(join(output,'parent-private/native-outcome.json')));const acceptedOutcome=await json(join(output,'parent-private/native-outcome.json'));assert.equal(acceptedOutcome.executionCompleted,true);assert.equal(acceptedOutcome.cleanupComplete,true);assert.equal(acceptedOutcome.observed.childModelRequestCount,3)
 assert.equal(process.platform,'darwin');assert.equal(process.arch,'arm64');assert.equal(process.versions.node.split('.')[0],'22')
 assert.equal(await hash(providerModule),providerSha256)
 const originalFetch=globalThis.fetch;let base,ledger,longRead,network,relay,provider,outcome,grading,gradingArchiveSha256,error=null,allocationClaimed=false,stage='claim';const closes={}
 try{
  await claimRecovery(m.prior.path,output,m.fingerprint);allocationClaimed=true
  stage='ledger';base=await Ledger.open(join(output,'provider-ledger.jsonl'),{total:11,perRun:11});ledger=recoveryBudget(base)
  stage='provider-setup'
  longRead=createLongReadProfile({baseFetch:originalFetch,bodyTimeoutMs:1_200_000})
  network=installNoReuseProfile({baseFetch:longRead.fetch,onDiagnostic:event=>base.appendSync({type:'network-diagnostic',event})});globalThis.fetch=network.fetch
  relay=await createAttachmentRelay({sourceRoot:ROOT,dataRoot:join(output,'attachments')})
  provider=await loadRealProvider({providerModule,providerSha256,providerPackage,credentialFile,dataRoot:join(output,'provider-private'),sourceRoot:ROOT,maxModelRequests:11,attachments:relay.store,onPhysical:()=>{throw Error('physical outside dispatcher')},onTransportEvent:event=>base.appendSync({type:'transport-event',event})})
  stage='native-execution';outcome=await executeCondition({manifest:m,condition:m.condition,provider,ledger,relay,task:{id:task.id,inputFiles:{'inputs/context.txt':task.context},instruction:m.condition.prompt.task},grade:()=>({primaryScore:0,schemaValid:false,errors:['official grading is parent-only']}),protectedRoots:[dirname(task.scorer.path),dirname(taskPathOf(m)),dirname(credentialFile),dirname(m.prior.path)]})
  let answer;try{answer=await readFile(join(m.condition.workspace,'answer.json'),'utf8');await writeFile(join(output,'parent-private/answer.json'),answer,{flag:'wx',mode:0o600});const parsed=JSON.parse(answer);assert.equal(typeof parsed,'string');const fullGrade=await gradeTask(task,parsed);await save(join(output,'parent-private/grading.json'),fullGrade);gradingArchiveSha256=await hash(join(output,'parent-private/grading.json'));grading=sanitizeGrade(fullGrade)}catch(e){grading={score:null,schemaValid:false,error:String(e)}}
 }catch(e){error=String(e)}finally{
  for(const [k,obj,method] of [['provider',provider,'close'],['relay',relay,'close'],['networkProfile',network,'dispose'],['longReadProfile',longRead,'close']])try{if(obj){await obj[method]();closes[k]='closed'}else closes[k]='not-created'}catch(e){closes[k]='failed';error??=String(e)}
  globalThis.fetch=originalFetch
 }
 const claimState=await inspectRecoveryClaim(m.prior.path,output,m.fingerprint);allocationClaimed=claimState.allocationOwned
 const accounting=ledger?await ledger.receipt():null
 const receipt={formatVersion:1,kind:'quality-recovery-final-receipt-v1',completedAt:new Date().toISOString(),fingerprint:m.fingerprint,sourceHead:m.sourceHead,allocationClaimed,claimState,ledgerOpened:!!base,providerLoaded:!!provider,stage,outcome,grading,gradingArchiveSha256,accounting,closes,error}
 await save(join(output,'final-receipt.json'),receipt);return receipt
}
function taskPathOf(m){return m.task.path}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const mode=process.argv[2],args={};for(let i=3;i<process.argv.length;i+=2)args[process.argv[i].slice(2)]=process.argv[i+1]
 const fn=mode==='prepare'?()=>prepareRecovery(args):mode==='accept'?()=>acceptRecovery(args.output):mode==='run'?()=>runRecovery(args):()=>{throw Error('mode must be prepare, accept or run')}
 fn().then(r=>console.log(JSON.stringify({kind:r.kind,fingerprint:r.fingerprint,accepted:r.accepted,realModelRequests:r.realModelRequests,accounting:r.accounting?{new:r.accounting.newAdmitted,cumulative:r.accounting.cumulativeAdmitted,confirmed:r.accounting.cumulativeConfirmed,unknown:r.accounting.cumulativeUnknown}:undefined,error:r.error}))).catch(e=>{console.error(e.stack);process.exitCode=1})
}

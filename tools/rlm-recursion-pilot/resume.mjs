#!/opt/homebrew/opt/node@22/bin/node
// Continue only cells which have never started. Unknown calls stay charged.
import { createHash } from 'node:crypto'
import { readFile, mkdir, open, lstat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { assertPreparedFingerprint, executeCondition } from './run.mjs'
import { aggregateBudgetView } from './control.mjs'
import { Ledger } from '../rlm-arc-pilot/ledger.mjs'
import { createAttachmentRelay } from '../rlm-arc-pilot/attachment-relay.mjs'
import { loadRealProvider } from '../rlm-arc-pilot/run.mjs'

const IDS = ['01S0', '01S', '02S', '02S0']
const HASH = /^[a-f0-9]{64}$/
const self = fileURLToPath(import.meta.url)
const hash = value => createHash('sha256').update(value).digest('hex')
const digest = async path => hash(await readFile(path))
const json = async path => JSON.parse(await readFile(path, 'utf8'))
const fail = (tag, text) => { const e = new Error(`RLM_RESUME_${tag}: ${text}`); e.code = `RLM_RESUME_${tag}`; throw e }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const exists = async path => { try { await lstat(path); return true } catch(e) { if(e.code === 'ENOENT') return false; throw e } }
async function write(path, value) {
  await mkdir(dirname(path), {recursive:true, mode:0o700})
  const fd = await open(path, 'wx', 0o600)
  try { await fd.writeFile(JSON.stringify(value, null, 2)+'\n'); await fd.sync() } finally { await fd.close() }
}

export function assertNetworkEnvironment(expected, actual) {
  if(expected===undefined) return
  if(!expected || !same(Object.keys(expected),['NO_PROXY']) || expected.NO_PROXY!=='chatgpt.com' || actual.NO_PROXY!==expected.NO_PROXY) fail('NETWORK','the accepted process-local proxy bypass is not active')
}

/** Pure validation. It neither refunds unknowns nor changes an old result. */
export function validateResumeEvidence({manifest, receipt, conditions, closure, ledgerReceipt}) {
  if(!manifest || !same(manifest.conditions?.map(c=>c.id), IDS) || manifest.prior?.charged!==463 || manifest.prior?.confirmed!==456 || manifest.prior?.unknown!==7) fail('MANIFEST','fixed four-cell manifest and historical prefix required')
  if(receipt?.fingerprint!==manifest.fingerprint || receipt?.closes?.provider!=='closed' || receipt?.closes?.relay!=='closed') fail('RECEIPT','previous provider and relay must be closed')
  if(closure?.kind!=='native-recursion-unstarted-closure-v1' || closure.fingerprint!==manifest.fingerprint || !['providerClosed','relayClosed','ownedProcessesAbsent','endpointsClosed'].every(k=>closure[k]===true) || !Array.isArray(closure.closedRuns)) fail('CLOSURE','independent effect-closure evidence is required')
  if(!Array.isArray(conditions) || !same(conditions.map(x=>x.condition?.id), IDS)) fail('CONDITIONS','condition evidence must preserve the fixed order')
  if(!Array.isArray(ledgerReceipt?.rows) || ledgerReceipt.priorAdmitted!==0) fail('LEDGER','fresh-stage ledger rows and counters are required')
  const admissions=ledgerReceipt.rows.filter(r=>r.type==='request-admitted')
  if(ledgerReceipt.admitted!==admissions.length || ledgerReceipt.newAdmitted!==admissions.length || admissions.length>56 || 463+admissions.length>522) fail('BUDGET','ledger counters exceed or disagree with 56/522 limits')
  const calls=new Map(), perRun=new Map(), alreadyClosed=new Set()
  for(const r of ledgerReceipt.rows) {
    if(r.type==='request-admitted') {
      if(!IDS.includes(r.run) || calls.has(r.id)) fail('LEDGER','unknown run or duplicate admission')
      calls.set(r.id,{run:r.run,state:'admitted'})
      perRun.set(r.run,(perRun.get(r.run)??0)+1)
      if(perRun.get(r.run)>14) fail('BUDGET','tree exceeds 14 requests')
    } else if(r.type==='request-settled') {
      const c=calls.get(r.id)
      if(!c || c.run!==r.run || c.state!=='admitted' || !['settled','unknown'].includes(r.state)) fail('LEDGER','invalid settlement')
      c.state=r.state
    } else if(r.type==='run-closed') alreadyClosed.add(r.run??r.runId)
  }
  if([...calls.values()].some(c=>c.state==='admitted')) fail('IN_FLIGHT','an admitted request is not settled')
  const byId=new Map(conditions.map(c=>[c.condition.id,c]))
  const closures=new Map()
  for(const c of closure.closedRuns) {
    const item=byId.get(c.run)
    const unknown=[...calls].filter(([,v])=>v.run===c.run && v.state==='unknown').map(([id])=>id)
    if(closures.has(c.run) || !item?.started || c.cause!=='transport_closed' || c.shutdownConfirmed!==true || c.workerExited!==true || !HASH.test(c.resultSha256??'') || c.resultSha256!==item.resultSha256 || !same(c.unknownCalls,unknown)) fail('CLOSURE','run closure must match the immutable result and exact unknown calls')
    closures.set(c.run,c)
  }
  let unstarted=false
  const eligible=[]
  for(const item of conditions) {
    const id=item.condition.id
    if(item.started===true) {
      if(unstarted || item.start?.fingerprint!==manifest.fingerprint || item.result?.condition?.id!==id || !HASH.test(item.resultSha256??'')) fail('PREFIX','started cells require immutable start/result evidence and a contiguous prefix')
      if(item.result.cleanupComplete!==true && !alreadyClosed.has(id) && !closures.has(id)) fail('CLOSURE','failed cleanup requires an independent closed-effect receipt')
    } else if(item.started===false) {
      unstarted=true
      if(item.result || item.start || (perRun.get(id)??0)>0) fail('REPLAY','an unstarted cell already has a result, marker or model admission')
      eligible.push(id)
    } else fail('CONDITIONS','started must be boolean')
  }
  if(!conditions.some(x=>x.started) || eligible.length===0) fail('NO_WORK','a started prefix and at least one never-started cell are required')
  for(const c of calls.values()) if(c.state==='unknown' && !alreadyClosed.has(c.run) && !closures.has(c.run)) fail('UNKNOWN','unknown effects have not been closed')
  return eligible
}

async function evidence(output, closureArtifact, closureSha256) {
  const root=resolve(output), m=await json(join(root,'prepared.json'))
  await assertPreparedFingerprint(m)
  if(m.output!==root || await digest(closureArtifact)!==closureSha256) fail('HASH','closure evidence changed')
  const closure=await json(closureArtifact)
  if(!closure.receipt?.path || await digest(closure.receipt.path)!==closure.receipt.sha256) fail('HASH','previous attempt receipt changed')
  const receipt=await json(closure.receipt.path)
  const start=await json(join(root,'real-run-started.json'))
  if(start.fingerprint!==m.fingerprint || await digest(start.acceptance.path)!==start.acceptance.sha256) fail('HASH','original accepted run changed')
  const accepted=await json(start.acceptance.path)
  if(accepted.manifestFingerprint!==m.fingerprint || accepted.compiledHash!==m.shared.compiled.hash || accepted.runtimeManifestSha256!==m.shared.runtime.manifest.sha256 || await digest(accepted.nativeAcceptance.path)!==accepted.nativeAcceptance.sha256) fail('HASH','original native acceptance changed')
  const conditions=[]
  for(const condition of m.conditions) {
    const sp=join(condition.markerDirectory,'real-condition-started.json'), rp=join(condition.markerDirectory,'result.json')
    const item={condition,started:await exists(sp)}
    if(item.started) { item.start=await json(sp); item.startSha256=await digest(sp) }
    if(await exists(rp)) { item.result=await json(rp); item.resultSha256=await digest(rp) }
    conditions.push(item)
  }
  const ledger=await Ledger.open(m.ledger.path,{total:56,perRun:14})
  const ledgerReceipt=await ledger.receipt()
  const eligible=validateResumeEvidence({manifest:m,receipt,conditions,closure,ledgerReceipt})
  return {root,m,closure,conditions,ledger,ledgerReceipt,eligible}
}

export async function prepareUnstartedResume({output,closureArtifact,closureSha256}) {
  const e=await evidence(output,closureArtifact,closureSha256)
  const dir=join(e.root,'continuations'); await mkdir(dir,{recursive:true,mode:0o700})
  let number=1
  while(await exists(join(dir,`acceptance-${String(number).padStart(2,'0')}.json`))) number++
  if(number>4) fail('NO_WORK','too many continuation reservations')
  const suffix=String(number).padStart(2,'0')
  const acceptance={formatVersion:1,kind:'native-recursion-unstarted-resume-v1',fingerprint:e.m.fingerprint,preparedAt:new Date().toISOString(),driver:{path:self,sha256:await digest(self)},closure:{path:resolve(closureArtifact),sha256:closureSha256},ledgerSha256:await digest(e.m.ledger.path),eligible:e.eligible,previousResults:e.conditions.filter(c=>c.started).map(c=>({id:c.condition.id,startSha256:c.startSha256,resultSha256:c.resultSha256})),marker:join(dir,`started-${suffix}.json`),receiptPath:join(dir,`receipt-${suffix}.json`)}
  const path=join(dir,`acceptance-${suffix}.json`);await write(path,acceptance)
  return {path,sha256:await digest(path),acceptance}
}

export async function resumeUnstartedPanel({output,acceptanceArtifact,acceptanceSha256,providerModule,providerSha256,providerPackage,credentialFile}) {
  if(await digest(acceptanceArtifact)!==acceptanceSha256) fail('HASH','continuation acceptance changed')
  const a=await json(acceptanceArtifact)
  if(a.kind!=='native-recursion-unstarted-resume-v1' || a.driver?.path!==self || a.driver.sha256!==await digest(self)) fail('HASH','continuation driver changed')
  const e=await evidence(output,a.closure.path,a.closure.sha256)
  if(a.fingerprint!==e.m.fingerprint || a.ledgerSha256!==await digest(e.m.ledger.path) || !same(a.eligible,e.eligible) || !same(a.previousResults,e.conditions.filter(c=>c.started).map(c=>({id:c.condition.id,startSha256:c.startSha256,resultSha256:c.resultSha256})))) fail('STALE','continuation evidence changed since preparation')
  if(process.platform!=='darwin' || process.arch!=='arm64' || process.versions.node.split('.')[0]!=='22') fail('RUNTIME','real continuation requires Node22 on macOS arm64')
  if(!HASH.test(providerSha256??'') || !providerModule || !providerPackage || !credentialFile) fail('ARGS','pinned provider paths required')
  assertNetworkEnvironment(e.closure.networkEnvironment,process.env)
  await write(a.marker,{formatVersion:1,time:new Date().toISOString(),fingerprint:e.m.fingerprint,acceptance:{path:resolve(acceptanceArtifact),sha256:acceptanceSha256},eligible:e.eligible})
  for(const c of e.closure.closedRuns) {
    if(c.unknownCalls.length && !e.ledger.closedRuns.has(c.run)) e.ledger.acknowledgeClosedRun({run:c.run,unknownCalls:c.unknownCalls,cause:c.cause,evidenceHash:{algorithm:'sha256',digest:a.closure.sha256}})
  }
  if(e.ledger.stopped) fail('STOPPED','ledger has unresolved effects after closure')
  const ledger=aggregateBudgetView(e.ledger,{runIds:IDS,priorCharged:463,priorConfirmed:456,priorUnknown:7,globalCap:522,maxNew:56,perTreeLimit:14})
  let provider,relay,error=null
  const results=[],closes={}
  try {
    const tasks=(await json(e.m.privateTasks.path)).tasks
    relay=await createAttachmentRelay({sourceRoot:e.m.runner.sourceRoot,dataRoot:join(dirname(a.receiptPath),`attachments-${Date.now()}`)})
    provider=await loadRealProvider({providerModule,providerSha256,providerPackage,credentialFile,dataRoot:join(dirname(a.receiptPath),`provider-${Date.now()}`),sourceRoot:e.m.runner.sourceRoot,maxModelRequests:56-e.ledgerReceipt.newAdmitted,attachments:relay.store,onPhysical:()=>fail('SCOPE','physical call outside a cell'),onTransportEvent:event=>e.ledger.appendSync({type:'transport-event',event})})
    for(const id of a.eligible) {
      if(ledger.stopped) break
      const c=e.m.conditions.find(c=>c.id===id), sp=join(c.markerDirectory,'real-condition-started.json'), rp=join(c.markerDirectory,'result.json')
      if(await exists(sp)||await exists(rp)) fail('REPLAY','eligible cell has started')
      await write(sp,{formatVersion:1,startedAt:new Date().toISOString(),fingerprint:e.m.fingerprint,id:c.id,arm:c.arm,continuation:a.marker})
      const outcome=await executeCondition({manifest:e.m,condition:c,provider,ledger,relay,task:tasks[c.taskIndex],protectedRoots:[dirname(resolve(credentialFile))]})
      const result={formatVersion:1,status:outcome.executionCompleted?'completed':'incomplete',...outcome}
      await write(rp,result);results.push(result)
      if(!result.cleanupComplete||ledger.stopped) break
    }
  } catch(cause) { error=String(cause?.stack??cause) }
  finally {
    try {await provider?.close();closes.provider='closed'}catch(cause){closes.provider=String(cause);error??=String(cause)}
    try {await relay?.close();closes.relay='closed'}catch(cause){closes.relay=String(cause);error??=String(cause)}
  }
  const accounting=await ledger.receipt()
  const result={formatVersion:1,kind:'native-recursion-unstarted-resume-receipt-v1',completedAt:new Date().toISOString(),fingerprint:e.m.fingerprint,acceptance:{path:resolve(acceptanceArtifact),sha256:acceptanceSha256},results:results.map(r=>({condition:r.condition,executionCompleted:r.executionCompleted,cleanupComplete:r.cleanupComplete,grading:r.grading,resources:r.resources,observed:r.observed})),accounting:{newAdmitted:accounting.newAdmitted,cumulativeAdmitted:accounting.cumulativeAdmitted,cumulativeConfirmed:accounting.cumulativeConfirmed,cumulativeUnknown:accounting.cumulativeUnknown,stopped:accounting.stopped},closes,error}
  await write(a.receiptPath,result)
  if(error) fail('STOPPED',error)
  return result
}

async function main() {
  const args=process.argv.slice(2), mode=args.shift(), values={}
  const names={'--output':'output','--closure-artifact':'closureArtifact','--closure-sha256':'closureSha256','--acceptance-artifact':'acceptanceArtifact','--acceptance-sha256':'acceptanceSha256','--provider-module':'providerModule','--provider-sha256':'providerSha256','--provider-package':'providerPackage','--credential-file':'credentialFile'}
  for(let i=0;i<args.length;i+=2) {const name=names[args[i]];if(!name||!args[i+1]||values[name])fail('ARGS','invalid arguments');values[name]=args[i+1]}
  if(mode==='--prepare') {const r=await prepareUnstartedResume(values);console.log(JSON.stringify({path:r.path,sha256:r.sha256,eligible:r.acceptance.eligible}));return}
  if(mode==='--run') {const r=await resumeUnstartedPanel(values);console.log(JSON.stringify({accounting:r.accounting,completed:r.results.length}));return}
  fail('ARGS','choose --prepare or --run')
}
if(process.argv[1]&&resolve(process.argv[1])===self) main().catch(e=>{process.stderr.write(String(e.stack??e)+'\n');process.exitCode=1})

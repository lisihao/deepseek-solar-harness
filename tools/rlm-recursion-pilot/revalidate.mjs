#!/opt/homebrew/opt/node@22/bin/node
// Fresh matched Q03 pair after transport failures. Old conditions are immutable.
import {createHash} from 'node:crypto'
import {readFile,writeFile,mkdir,lstat,symlink,open} from 'node:fs/promises'
import {join,dirname,resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import dns from 'node:dns'
import net from 'node:net'
import {installNoReuseProfile} from './network-profile.mjs'
import {assertPreparedFingerprint,executeCondition} from './run.mjs'
import {Ledger} from '../rlm-arc-pilot/ledger.mjs'
import {loadRealProvider} from '../rlm-arc-pilot/run.mjs'
import {createAttachmentRelay} from '../rlm-arc-pilot/attachment-relay.mjs'
const self=fileURLToPath(import.meta.url), hash=b=>createHash('sha256').update(b).digest('hex'), digest=async p=>hash(await readFile(p)), json=async p=>JSON.parse(await readFile(p,'utf8'))
const fail=(tag,text)=>{const e=new Error(`RLM_REVALIDATE_${tag}: ${text}`);e.code=`RLM_REVALIDATE_${tag}`;throw e}
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b)
const exists=async p=>{try{await lstat(p);return true}catch(e){if(e.code==='ENOENT')return false;throw e}}
async function write(p,v){await mkdir(dirname(p),{recursive:true,mode:0o700});const f=await open(p,'wx',0o600);try{await f.writeFile(JSON.stringify(v,null,2)+'\n');await f.sync()}finally{await f.close()}}

export function validateRevalidation(m){
 const v2=m?.kind==='native-recursion-no-reuse-revalidation-v2', prior=v2?{charged:481,confirmed:470,unknown:11}:{charged:472,confirmed:462,unknown:10}, ids=v2?['v2S0','v2S']:['v1S0','v1S']
 if(!v2&&m?.kind!=='native-recursion-ipv4-revalidation-v1'||!same(m.prior,prior))fail('PRIOR','retain the complete charged prefix and unknowns')
 if(m.limits?.total!==28||m.limits?.perTree!==14||m.limits?.cap!==522||m.prior.charged+m.limits.total>m.limits.cap)fail('BUDGET','fixed 28/14/522 limits required')
 if(m.network?.NO_PROXY!=='chatgpt.com'||m.network?.dnsOrder!=='ipv4first'||m.network?.autoSelectFamily!==false||(v2&&m.network?.connectionClose!==true))fail('NETWORK','fixed process-local network profile required')
 if(!Array.isArray(m.conditions)||!same(m.conditions.map(c=>[c.id,c.arm,c.taskIndex]),[[ids[0],'S0',1],[ids[1],'S',1]]))fail('CONDITIONS','exactly fresh S0/S Q03 conditions required')
 const [a,b]=m.conditions
 if(typeof a.prompt?.task!=='string'||!a.prompt.task||a.prompt.task!==b.prompt?.task||!a.inputHashes||Object.keys(a.inputHashes).length!==2||!same(a.inputHashes,b.inputHashes)||!Object.values(a.inputHashes).every(h=>/^[a-f0-9]{64}$/.test(h)))fail('FAIRNESS','identical complete input hashes and task required')
 return true
}
// These are historical one-shot phases, not fresh spending namespaces.
export function assertRevalidationOutput(originalOutput, output, noReuse = false) {
 const expected = join(resolve(originalOutput), 'revalidation', noReuse ? 'no-reuse-v2' : 'ipv4-v1')
 if (resolve(output) !== expected) fail('FRESH', 'historical phase output is fixed; a new directory cannot reset its charged prefix')
 return expected
}
function fingerprint(m){const {fingerprint:ignored,...body}=m;return hash(JSON.stringify(body))}
async function priorEvidence(originalOutput,retirementArtifact,retirementSha256){
 const originalPath=join(originalOutput,'prepared.json'),original=await json(originalPath)
 await assertPreparedFingerprint(original)
 if(await digest(retirementArtifact)!==retirementSha256)fail('HASH','retirement evidence changed')
 const retirement=await json(retirementArtifact)
 if(retirement.kind!=='native-recursion-network-retirement-v1'||retirement.fingerprint!==original.fingerprint||retirement.ownedProcessesAbsent!==true||retirement.endpointsClosed!==true||retirement.providerClosed!==true||retirement.relayClosed!==true)fail('CLOSURE','old effects must be closed before a fresh pair')
 if(await digest(original.ledger.path)!==retirement.priorLedgerSha256)fail('HASH','old ledger changed')
 const base=await Ledger.open(original.ledger.path,{total:56,perRun:14}),r=await base.receipt()
 if(r.newAdmitted!==9||r.settled!==6||r.unknown!==3||r.physicalAdmitted!==9||r.rows.some(x=>x.type==='request-admitted'&&!r.rows.some(y=>y.type==='request-settled'&&y.id===x.id)))fail('PRIOR','old nine requests must remain fully charged with three unknowns')
 if(await digest(retirement.attemptReceipt.path)!==retirement.attemptReceipt.sha256)fail('HASH','last attempt receipt changed')
 const last=await json(retirement.attemptReceipt.path)
 if(last.closes?.provider!=='closed'||last.closes?.relay!=='closed'||last.fingerprint!==original.fingerprint)fail('CLOSURE','last provider/relay not closed')
 return {original,originalPath,retirement}
}

async function previousPhaseEvidence(path,sha256){
 if(await digest(path)!==sha256)fail('HASH','previous phase closure changed')
 const proof=await json(path)
 if(proof.kind!=='native-recursion-no-reuse-retirement-v2'||!['ownedProcessesAbsent','endpointsClosed','providerClosed','relayClosed','nativePhysicalCleanup'].every(k=>proof[k]===true)||!same(proof.prior,{charged:481,confirmed:470,unknown:11}))fail('CLOSURE','previous phase closure or budget invalid')
 for(const key of ['phaseManifest','phaseReceipt','driverSnapshot'])if(await digest(proof[key].path)!==proof[key].sha256)fail('HASH','previous phase evidence changed')
 const m=await json(proof.phaseManifest.path),r=await json(proof.phaseReceipt.path)
 if(m.kind!=='native-recursion-ipv4-revalidation-v1'||proof.fingerprint!==m.fingerprint||r.fingerprint!==m.fingerprint||await digest(m.ledgerPath)!==proof.phaseLedgerSha256||r.closes?.provider!=='closed'||r.closes?.relay!=='closed'||r.accounting.cumulativeAdmitted!==481||r.accounting.cumulativeConfirmed!==470||r.accounting.cumulativeUnknown!==11)fail('PRIOR','previous phase accounting changed')
 const ledger=await Ledger.open(m.ledgerPath,{total:28,perRun:14}),receipt=await ledger.receipt()
 if(receipt.newAdmitted!==9||receipt.settled!==8||receipt.unknown!==1||receipt.physicalAdmitted!==9)fail('PRIOR','retain nine additional requests and one unknown')
 return proof
}

export async function prepareRevalidation({originalOutput,output,tempRoot='/private/tmp/rr3',retirementArtifact,retirementSha256,previousPhaseArtifact,previousPhaseSha256}){
 const old=await priorEvidence(originalOutput,retirementArtifact,retirementSha256),root=resolve(output),tmp=resolve(tempRoot)
 const previous=previousPhaseArtifact?await previousPhaseEvidence(previousPhaseArtifact,previousPhaseSha256):null,v2=previous!==null
 assertRevalidationOutput(originalOutput, root, v2)
 if(await exists(root)||await exists(tmp)||!tmp.startsWith('/private/tmp/')||tmp.length>25)fail('FRESH','fresh short native root and persistent output required')
 await mkdir(root,{recursive:true,mode:0o700});await mkdir(tmp,{recursive:true,mode:0o700})
 const task=(await json(old.original.privateTasks.path)).tasks[1],template=old.original.conditions.find(c=>c.taskIndex===1&&c.arm==='S0'),conditions=[]
 for(const [id,arm]of(v2?[['v2S0','S0'],['v2S','S']]:[['v1S0','S0'],['v1S','S']])){
  const runDirectory=join(tmp,'runs',id),workspace=join(runDirectory,'workspace'),durableDirectory=join(root,'runs',id),markerDirectory=join(durableDirectory,'markers')
  for(const d of [workspace,join(runDirectory,'home'),join(runDirectory,'tmp'),join(runDirectory,'data'),join(durableDirectory,'parent-intents'),markerDirectory])await mkdir(d,{recursive:true,mode:0o700})
  await symlink(old.original.shared.runtime.runtimes,join(runDirectory,'data/runtimes'),'dir')
  const inputHashes={}
  for(const [name,text]of Object.entries(task.inputFiles)){const p=join(workspace,name);await mkdir(dirname(p),{recursive:true,mode:0o700});await writeFile(p,text,{mode:0o600,flag:'wx'});inputHashes[name]=hash(text)}
  conditions.push({id,arm,taskIndex:1,taskId:task.id,kind:'Q03',runDirectory,workspace,data:join(runDirectory,'data'),durableDirectory,markerDirectory,prompt:{task:task.instruction,sha256:hash(task.instruction)},inputHashes,autonomous:{...template.autonomous,gate:template.autonomous.gate.replaceAll(template.workspace,workspace)}})
 }
 const m={formatVersion:1,kind:v2?'native-recursion-no-reuse-revalidation-v2':'native-recursion-ipv4-revalidation-v1',createdAt:new Date().toISOString(),output:root,tmpRoot:tmp,prior:v2?{charged:481,confirmed:470,unknown:11}:{charged:472,confirmed:462,unknown:10},limits:{total:28,perTree:14,cap:522},network:{NO_PROXY:'chatgpt.com',dnsOrder:'ipv4first',autoSelectFamily:false,...(v2?{connectionClose:true}:{})},...(v2?{previousPhase:{path:resolve(previousPhaseArtifact),sha256:previousPhaseSha256},networkModule:{path:join(dirname(self),'network-profile.mjs'),sha256:await digest(join(dirname(self),'network-profile.mjs'))}}:{}),original:{path:old.originalPath,sha256:await digest(old.originalPath)},retirement:{path:resolve(retirementArtifact),sha256:retirementSha256},driver:{path:self,sha256:await digest(self)},shared:old.original.shared,package:old.original.package,runner:old.original.runner,parentPrivate:old.original.parentPrivate,privateTasks:old.original.privateTasks,conditions,ledgerPath:join(root,'provider-ledger.jsonl')}
 validateRevalidation(m);m.fingerprint=fingerprint(m)
 await Ledger.open(m.ledgerPath,{total:28,perRun:14});await write(join(root,'prepared.json'),m)
 return {path:join(root,'prepared.json'),sha256:await digest(join(root,'prepared.json')),fingerprint:m.fingerprint}
}
function budgetView(base,m){return{admit:(run,req)=>{if(!m.conditions.some(c=>c.id===run))fail('BUDGET','unexpected tree');return base.admit(run,req)},admitPhysical:x=>base.admitPhysical(x),settle:(...x)=>base.settle(...x),appendSync:x=>base.appendSync(x),get stopped(){return base.stopped},get calls(){return base.calls},async receipt(){const r=await base.receipt();return{...r,cumulativeAdmitted:m.prior.charged+r.newAdmitted,cumulativeConfirmed:m.prior.confirmed+r.settled,cumulativeUnknown:m.prior.unknown+r.unknown}}}}
export async function runRevalidation({manifestArtifact,manifestSha256,providerModule,providerSha256,providerPackage,credentialFile}){
 if(await digest(manifestArtifact)!==manifestSha256)fail('HASH','phase manifest changed')
 const m=await json(manifestArtifact);validateRevalidation(m)
 assertRevalidationOutput(dirname(m.original.path), m.output, Boolean(m.previousPhase))
 if(fingerprint(m)!==m.fingerprint||m.driver.path!==self||m.driver.sha256!==await digest(self))fail('HASH','phase driver/fingerprint changed')
 if(process.platform!=='darwin'||process.arch!=='arm64'||process.versions.node.split('.')[0]!=='22'||process.env.NO_PROXY!==m.network.NO_PROXY||dns.getDefaultResultOrder()!==m.network.dnsOrder||net.getDefaultAutoSelectFamily()!==false)fail('NETWORK','actual process does not match accepted Node22/macOS/IPv4 profile')
 if(await digest(m.original.path)!==m.original.sha256)fail('HASH','original source manifest changed')
 await priorEvidence(dirname(m.original.path),m.retirement.path,m.retirement.sha256)
 if(m.previousPhase){await previousPhaseEvidence(m.previousPhase.path,m.previousPhase.sha256);if(await digest(m.networkModule.path)!==m.networkModule.sha256)fail('HASH','network profile module changed')}
 const tasks=(await json(m.privateTasks.path)).tasks
 for(const c of m.conditions)for(const [name,h]of Object.entries(c.inputHashes))if(await digest(join(c.workspace,name))!==h)fail('HASH','public inputs changed')
 const base=await Ledger.open(m.ledgerPath,{total:28,perRun:14});if((await base.receipt()).admitted!==0)fail('REPLAY','phase ledger has already admitted work')
 await write(join(m.output,'real-run-started.json'),{formatVersion:1,fingerprint:m.fingerprint,manifest:{path:resolve(manifestArtifact),sha256:manifestSha256},network:m.network,time:new Date().toISOString()})
 const ledger=budgetView(base,m),results=[],closes={};let provider,relay,networkProfile,error=null;const originalFetch=globalThis.fetch
 try{
  if(m.network.connectionClose){networkProfile=installNoReuseProfile({baseFetch:originalFetch,onDiagnostic:event=>base.appendSync({type:'network-diagnostic',event})});globalThis.fetch=networkProfile.fetch}
  relay=await createAttachmentRelay({sourceRoot:m.runner.sourceRoot,dataRoot:join(m.output,'attachments')})
  provider=await loadRealProvider({providerModule,providerSha256,providerPackage,credentialFile,dataRoot:join(m.output,'provider-private'),sourceRoot:m.runner.sourceRoot,maxModelRequests:28,attachments:relay.store,onPhysical:()=>fail('SCOPE','request outside condition'),onTransportEvent:event=>base.appendSync({type:'transport-event',event})})
  for(const c of m.conditions){
   if(ledger.stopped)break
   await write(join(c.markerDirectory,'real-condition-started.json'),{formatVersion:1,fingerprint:m.fingerprint,id:c.id,arm:c.arm,time:new Date().toISOString()})
   const outcome=await executeCondition({manifest:m,condition:c,provider,ledger,relay,task:tasks[1],protectedRoots:[dirname(resolve(credentialFile))]})
   const result={formatVersion:1,status:outcome.executionCompleted?'completed':'incomplete',...outcome};await write(join(c.markerDirectory,'result.json'),result);results.push(result)
   if(!result.cleanupComplete||ledger.stopped)break
  }
 }catch(e){error=String(e.message??e)}finally{try{await provider?.close();closes.provider='closed'}catch(e){closes.provider=String(e);error??=String(e)}try{await relay?.close();closes.relay='closed'}catch(e){closes.relay=String(e);error??=String(e)}if(networkProfile){networkProfile.dispose();if(globalThis.fetch!==networkProfile.fetch)error??='network profile restoration mismatch';else globalThis.fetch=originalFetch;closes.networkProfile='disposed'}}
 const r=await ledger.receipt(),receipt={formatVersion:1,kind:m.kind==='native-recursion-no-reuse-revalidation-v2'?'native-recursion-no-reuse-revalidation-receipt-v2':'native-recursion-ipv4-revalidation-receipt-v1',time:new Date().toISOString(),fingerprint:m.fingerprint,network:m.network,results,accounting:{newAdmitted:r.newAdmitted,physicalAdmitted:r.physicalAdmitted,cumulativeAdmitted:r.cumulativeAdmitted,cumulativeConfirmed:r.cumulativeConfirmed,cumulativeUnknown:r.cumulativeUnknown,stopped:r.stopped},closes,error}
 await write(join(m.output,'run-receipt.json'),receipt);if(error)fail('STOPPED',error);return receipt
}
async function main(){const argv=process.argv.slice(2),mode=argv.shift(),v={},names={'--original-output':'originalOutput','--output':'output','--temp-root':'tempRoot','--retirement-artifact':'retirementArtifact','--retirement-sha256':'retirementSha256','--previous-phase-artifact':'previousPhaseArtifact','--previous-phase-sha256':'previousPhaseSha256','--manifest-artifact':'manifestArtifact','--manifest-sha256':'manifestSha256','--provider-module':'providerModule','--provider-sha256':'providerSha256','--provider-package':'providerPackage','--credential-file':'credentialFile'};for(let i=0;i<argv.length;i+=2){const k=names[argv[i]];if(!k||!argv[i+1]||v[k])fail('ARGS','invalid args');v[k]=argv[i+1]}if(mode==='--prepare'){console.log(JSON.stringify(await prepareRevalidation(v)));return}if(mode==='--run'){const r=await runRevalidation(v);console.log(JSON.stringify({accounting:r.accounting,recorded:r.results.length}));return}fail('ARGS','choose --prepare or --run')}
if(process.argv[1]&&resolve(process.argv[1])===self)main().catch(e=>{process.stderr.write(String(e.stack??e)+'\n');process.exitCode=1})

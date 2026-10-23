import {createServer} from 'node:http';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import assert from 'node:assert/strict';
export const name='hindsight-score-fixture';
export async function apply(ctx){
 let source,sourceId,sourceOwner,timer;
 const seen=[];
 const server=createServer(async(req,res)=>{
  try{
   let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);
   assert.equal(req.method,'POST');assert.equal(req.url,'/v1/default/banks/fixture%3A%3Aproject/memories/recall');
   assert.deepEqual(Object.keys(body).sort(),['budget','max_tokens','prefer_observations','query','types']);
   assert.equal(body.query,'synthetic ordinary query');seen.push(body);
   res.setHeader('content-type','application/json');
   res.end(JSON.stringify({results:[{id:'relevant-low',text:'Synthetic relevant ranking result',score:.08,type:'experience'},{id:'rank-boost',text:'Synthetic boosted ranking result',score:1.2,type:'experience'},{id:'third',text:'Synthetic third result',score:.07,type:'experience'}]}));
  }catch(error){res.statusCode=500;res.end(JSON.stringify({error:error.message}))}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const dataDir=join(process.env.DSH_HOME,'fixture-data');await mkdir(join(dataDir,'state'),{recursive:true});
 const timestamp=new Date().toISOString();
 await writeFile(join(dataDir,'state/memory-providers.json'),JSON.stringify({version:4,services:{hindsight:{endpoint:'http://127.0.0.1:'+server.address().port}},enabled:{hindsight:true},bodies:[{id:'fixture-hindsight',name:'Synthetic project bank',description:'No real memory',active:true,providerId:'hindsight',externalId:'fixture::project',connection:{bankId:'fixture::project',budget:'mid'},createdAt:timestamp,updatedAt:timestamp}]}));
 ctx.provide('mnemonMemory',{installContributions(value,options){
  assert.equal(value.sources.length,1);assert.equal(source,undefined,'A second Source was mounted');source=value.sources[0];sourceId='source:'+options.instanceId;sourceOwner=options.instanceId;return()=>{};
 }});
 const start=()=>{
  let attempts=0;
  timer=setInterval(()=>{void(async()=>{
   if(!source){if(++attempts>100)throw new Error('Source never activated');return}
   clearInterval(timer);
   const instance=source.create({sourceInstanceKey:sourceId,configuration:{dataDir,timeoutMs:60000,embedding:{enabled:false}}});
   try{
    const result=(await instance.manage({mode:'read',operation:'search',input:{query:'synthetic ordinary query',limit:10}})).value;
    const adapted=process.env.SCORE_FIXTURE_ADAPTED==='1';
    const ids=result.results.map(r=>r.id);
    assert.equal(ids.includes('relevant-low'),adapted);
    assert.equal(result.results.length,adapted?2:1);assert.equal(seen.length,1);
    if(adapted){assert.deepEqual(ids,['rank-boost','relevant-low']);for(const item of result.results){assert.equal(item.relevanceTier,'unknown');assert.equal(item.normalizedScore,undefined)}}
    assert(sourceOwner.endsWith('mnemon-source-memory-spaces'));
    const receipt={fixtureOnly:true,actualBuiltSource:true,loadedByOfficialCLI:true,adapted,ids,sourceIdentity:sourceId,requestCount:seen.length,noFilters:true,pass:true};
    await writeFile(process.env.SCORE_FIXTURE_RECEIPT,JSON.stringify(receipt,null,2));
   }finally{await instance.dispose()}
   process.kill(process.pid,'SIGTERM');
  })().catch(error=>{clearInterval(timer);console.error(error);process.exitCode=1;process.kill(process.pid,'SIGTERM')})},25);
 };
 start();
 return()=>{clearInterval(timer);server.closeAllConnections();server.close()};
}

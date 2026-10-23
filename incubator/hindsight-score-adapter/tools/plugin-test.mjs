import {spawn} from 'node:child_process';
import {mkdtemp,mkdir,readFile,writeFile} from 'node:fs/promises';
import {join,resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const scratch=await mkdtemp(join(process.platform==='darwin'?'/private/tmp':tmpdir(),'dsh-score-plugin-'));
const artifacts=join(scratch,'artifacts');await mkdir(artifacts);
const home=join(scratch,'home');await mkdir(home);
const env={...process.env,HOME:home,DSH_HOME:join(scratch,'dsh'),XDG_CONFIG_HOME:join(home,'config'),XDG_DATA_HOME:join(home,'data'),XDG_STATE_HOME:join(home,'state'),npm_config_userconfig:'/dev/null',npm_config_globalconfig:'/dev/null',DSH_TELEMETRY_DISABLED:'1'};
for(const key of Object.keys(env))if(/(?:^|_)(?:API_KEY|ACCESS_TOKEN|AUTH_TOKEN|SECRET|PASSWORD|CREDENTIALS|OAUTH|BEARER)(?:_|$)/i.test(key))delete env[key];
const cli=process.env.DSH_TEST_BIN??join(root,'node_modules/.bin/dsh');
const profile=join(env.DSH_HOME,'profiles/score-test');
await mkdir(profile,{recursive:true});
await writeFile(join(profile,'package.json'),JSON.stringify({name:'dsh-score-fixture-profile',private:true,dependencies:{},pnpm:{overrides:{'dsh-mnemon':'0.5.32'}},dsh:{profile:{bundles:['@deepseek-ai/dsh-base']}}}));
let sequence=0;
async function run(cmd,args,cwd=root,extra={}){
 const child=spawn(cmd,args,{cwd,env:{...env,...extra},stdio:['ignore','pipe','pipe']});let output='';
 child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 const timer=setTimeout(()=>child.kill('SIGTERM'),120000);
 const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)});clearTimeout(timer);
 await writeFile(join(scratch,'command-'+(++sequence)+'.log'),output);
 if(code!==0)throw new Error(cmd+' '+args.join(' ')+' failed '+code+'\n'+output);
 return output;
}
await run('pnpm',['pack','--pack-destination',artifacts],join(root,'tools/fixture'));
await run('pnpm',['pack','--pack-destination',artifacts]);
const fixture=join(artifacts,'dsh-hindsight-score-fixture-0.0.0.tgz');
const adapter=join(artifacts,'lisihao-dsh-solar-hindsight-score-adapter-0.0.0.tgz');
const baseline=JSON.parse(await readFile(join(root,'node_modules/dsh-mnemon/package.json'),'utf8'));
assert.equal(baseline.version,'0.5.32');
const providerSpecs=Object.entries(baseline.dependencies).filter(([name])=>name.startsWith('dsh-mnemon-provider-')).map(([name,version])=>name+'@'+version);
await run(cli,['plugin','--profile','score-test','add',fixture,'dsh-mnemon-source-memory-spaces@0.5.22','@deepseek-ai/cordis@4.0.5',...providerSpecs]);
const receipts=[];
async function boot(label,adapted){
 const receipt=join(scratch,label+'.json');
 await run(cli,['--profile','score-test'],root,{SCORE_FIXTURE_ADAPTED:adapted?'1':'0',SCORE_FIXTURE_RECEIPT:receipt});
 const data=JSON.parse(await readFile(receipt,'utf8'));assert.equal(data.pass,true);receipts.push({phase:label,...data});
}
await boot('baseline',false);
await run(cli,['plugin','--profile','score-test','add',adapter]);
await boot('adapted',true);
await run(cli,['plugin','--profile','score-test','remove','@lisihao/dsh-solar-hindsight-score-adapter']);
await boot('removed',false);
console.log(JSON.stringify({scratch,noLiveModels:true,receipts,pass:true},null,2));

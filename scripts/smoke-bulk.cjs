// Run inside API container; authentication remains in runtime memory.
const { readFile } = require('node:fs/promises');
async function main() {
  const base=`http://127.0.0.1:${process.env.PORT||3000}`,headers={'X-API-Key':process.env.API_KEY};
  const form=new FormData();form.append('file',new Blob([await readFile('data/cities-valid.csv')],{type:'text/csv'}),'cities.csv');
  const accepted=await fetch(base+'/bulk/import',{method:'POST',headers,body:form});
  if(accepted.status!==202){const e=await accepted.json();throw new Error(`Admission ${accepted.status} ${e.code}`);}
  const {job_id}=await accepted.json();console.log(JSON.stringify({admission:202,job_id}));
  let s;
  const deadline=Date.now()+60000;
  do {
    const res=await fetch(`${base}/bulk/jobs/${job_id}`,{headers});if(res.status!==200)throw new Error(`Status ${res.status}`);s=await res.json();
    if(['done','failed','pending'].includes(s.status))break;
    await new Promise(resolve=>setTimeout(resolve,1000));
  }while(Date.now()<deadline);
  const results=await fetch(`${base}/bulk/jobs/${job_id}/results?limit=1`,{headers});if(results.status!==200)throw new Error('Results failed.');
  const page=await results.json();if(page.entries.length!==1)throw new Error('Missing admission membership.');
  if(s.total!==s.processed+s.pending+s.in_flight || s.processed!==s.succeeded+s.failed)throw new Error('Counter invariant failed.');
  console.log(JSON.stringify({status:s.status,total:s.total,succeeded:s.succeeded,failed:s.failed,pending:s.pending,blocking_reasons:s.blocking_reasons,results:200}));
  if(s.status==='failed'||!['done','pending'].includes(s.status))process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});

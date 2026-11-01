import http from 'node:http';
import sharp from 'sharp';
sharp.concurrency(1);
import {randomUUID, randomBytes, timingSafeEqual} from 'node:crypto';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, code) => Object.assign(new Error(code), {status, code});
const secret = () => randomBytes(32).toString('base64url');
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function normalize(result, image) {
  if (!Array.isArray(result.results)) throw fail(502, 'provider_response');
  const candidates = result.results.filter(r => typeof r.species?.scientificNameWithoutAuthor === 'string' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 1).slice(0,3).map(r => ({
    taxonId: r.gbif?.id ? `gbif:${r.gbif.id}` : undefined,
    rank: 'species', scientificName: r.species.scientificNameWithoutAuthor.slice(0,200),
    germanName: r.species.commonNames?.find(n => typeof n === 'string')?.slice(0,200),
    score: r.score, level: 'suggestion'
  }));
  return {mediaId:image.mediaId, frameId:image.frameId, timestamp:image.timestamp, objectType:'plant', level:candidates.length ? 'suggestion' : 'unclear', needsCloseUp:true, closeUpHint:'leaf', candidates};
}

export async function identify(bytes, key, fetcher = fetch, signal) {
  const url = new URL('https://my-api.plantnet.org/v2/identify/all');
  url.searchParams.set('api-key', key);
  url.searchParams.set('lang', 'de');
  url.searchParams.set('nb-results', '3');
  const body = new FormData();
  body.append('images', new Blob([bytes], {type:'image/jpeg'}), 'plant.jpg');
  body.append('organs', 'auto');
  const response = await fetcher(url, {method:'POST',body,signal:AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(15000)])});
  // Pl@ntNet rejection: no plant matched. Never override using no-reject.
  if (response.status === 404) return {results:[]};
  if (!response.ok) throw fail(502, response.status === 429 ? 'provider_quota' : 'provider_unavailable');
  return response.json();
}

export function createBackend({baseURL, apiKey, betaKey, dailyLimit=100, identifyImage=identify, now=Date.now} = {}) {
  if (!baseURL || !apiKey || !betaKey || betaKey.length < 32) throw new Error('BASE_URL, PLANTNET_API_KEY and BETA_ACCESS_KEY (>=32 characters) required');
  if (!Number.isInteger(dailyLimit) || dailyLimit < 1 || dailyLimit > 10000) throw new Error('Invalid DAILY_IMAGE_LIMIT');
  const origin = new URL(baseURL);
  if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password || !['https:','http:'].includes(origin.protocol)) throw new Error('BASE_URL must be an origin');
  const sessions = new Map(), jobs = new Map(), rates = new Map();
  let budgetDay = '', spent = 0;
  const charge = count => {
    const day = new Date(now()).toISOString().slice(0,10);
    if (day !== budgetDay) { budgetDay=day; spent=0; }
    if (spent + count > dailyLimit) throw fail(429,'daily_budget');
    spent += count;
  };
  const purge = () => {
    const t=now();
    for(const [k,s] of sessions) if(s.expires<=t) sessions.delete(k);
    for(const [k,j] of jobs) if(j.expires<=t) { j.abort.abort(); jobs.delete(k); }
    for(const [k,r] of rates) if(r.until<=t) rates.delete(k);
  };
  const rate = key => {
    let r=rates.get(key);
    if (!r || r.until<=now()) { if(rates.size>=1000) throw fail(429,'busy'); r={n:0,until:now()+60000}; rates.set(key,r); }
    if(++r.n>30) throw fail(429,'rate_limited');
  };
  const read = async (req, max) => {
    if(Number(req.headers['content-length'])>max) throw fail(413,'too_large');
    let size=0; const chunks=[];
    for await(const chunk of req) {size+=chunk.length; if(size>max) throw fail(413,'too_large'); chunks.push(chunk);}
    return Buffer.concat(chunks);
  };
  const json = async req => {
    if(req.headers['content-type']?.split(';')[0] !== 'application/json') throw fail(415,'json_required');
    try { return JSON.parse(await read(req,16384)); } catch(e) {if(e.status) throw e; throw fail(400,'invalid_json');}
  };
  const reply = (res,status,obj) => {res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'}); res.end(JSON.stringify(obj));};
  const run = async job => {
    try {
      const observations=[];
      for(const slot of job.slots) {
        if(job.abort.signal.aborted) return;
        const data=await identifyImage(slot.bytes,apiKey,fetch,job.abort.signal);
        if(job.abort.signal.aborted) return;
        observations.push(normalize(data,slot.image));
        job.modelVersion = typeof data.version === 'string' ? data.version.slice(0,100) : undefined;
        slot.bytes=undefined;
      }
      job.observations=observations; job.status='completed';
    } catch { if(!job.abort.signal.aborted) {job.status='failed';job.errorCode='recognition_failed';} }
    finally { for(const slot of job.slots) slot.bytes=undefined; }
  };
  const server=http.createServer(async(req,res)=>{
    try {
      purge(); rate(req.socket.remoteAddress);
      const path=new URL(req.url,'http://local').pathname;
      if(req.method==='GET' && path==='/health') return reply(res,200,{status:'ok'});
      if(req.method==='POST' && path==='/v1/sessions') {
        if(!equal(req.headers['x-grunna-beta-key'],betaKey)) throw fail(401,'beta_access_required');
        const body=await json(req);
        if(!uuid.test(body.installationId)) throw fail(400,'invalid_installation');
        if(sessions.size>=500) throw fail(429,'busy');
        const token=secret(); sessions.set(token,{owner:body.installationId.toLowerCase(),expires:now()+600000});
        return reply(res,200,{token,expiresIn:600});
      }
      // Uploads use an unguessable per-slot capability and expire with their job.
      const upload=path.match(/^\/v1\/uploads\/([\w-]+)\/([\w-]+)$/);
      if(req.method==='PUT' && upload) {
        const job=jobs.get(upload[1]), slot=job?.slots.find(s=>equal(s.token,upload[2]));
        if(!slot || job.status!=='pending') throw fail(404,'upload_not_found');
        if(req.headers['content-type']?.split(';')[0]!=='image/jpeg') throw fail(415,'jpeg_required');
        if(slot.uploading) throw fail(409,'upload_in_progress');
        slot.uploading=true;
        try {
          const bytes=await read(req,5*1024*1024);
          if(bytes.length!==slot.image.byteSize || bytes.length<4 || bytes[0]!==255 || bytes[1]!==216 || bytes.at(-2)!==255 || bytes.at(-1)!==217) throw fail(400,'invalid_jpeg');
          try {
            const image=sharp(bytes,{limitInputPixels:2048*2048,failOn:'warning'});
            const meta=await image.metadata();
            if(meta.format!=='jpeg'||meta.width!==slot.image.width||meta.height!==slot.image.height) throw new Error('dimensions');
            slot.bytes=await image.rotate().jpeg({quality:90}).toBuffer(); // decode fully and strip metadata
          } catch {throw fail(400,'invalid_jpeg');}
        } finally {slot.uploading=false;}
        return reply(res,200,{});
      }
      const session=sessions.get(req.headers.authorization?.replace(/^Bearer /,''));
      if(!session) throw fail(401,'unauthorized');
      rate(`owner:${session.owner}`);
      if(req.method==='POST' && path==='/v1/analyses') {
        const body=await json(req), key=req.headers['idempotency-key'];
        if(!uuid.test(key) || body.clientJobId!==key || !Array.isArray(body.media) || body.media.length<1 || body.media.length>6) throw fail(400,'invalid_request');
        const seen=new Set();
        for(const m of body.media) {
          const ref=`${m.mediaId}:${m.frameId??''}`;
          if(!uuid.test(m.mediaId) || (m.frameId!==undefined && !uuid.test(m.frameId)) || (m.timestamp!==undefined && (!Number.isFinite(m.timestamp)||m.timestamp<0||m.timestamp>30)) || m.contentType!=='image/jpeg' || !Number.isInteger(m.byteSize)||m.byteSize<4||m.byteSize>5*1024*1024 || !Number.isInteger(m.width)||!Number.isInteger(m.height)||m.width<1||m.height<1||m.width>2048||m.height>2048 || seen.has(ref)) throw fail(400,'invalid_media');
          seen.add(ref);
        }
        const fingerprint=JSON.stringify(body.media);
        let job=[...jobs.values()].find(j=>j.owner===session.owner && j.key===key);
        if(job && job.fingerprint!==fingerprint) throw fail(409,'idempotency_conflict');
        if(!job) {
          if(jobs.size>=20 || [...jobs.values()].filter(j=>j.owner===session.owner).length>=3) throw fail(429,'busy');
          job={id:randomUUID(),owner:session.owner,key,fingerprint,status:'pending',expires:now()+600000,abort:new AbortController(),slots:body.media.map(image=>({image,token:secret()}))};
          jobs.set(job.id,job);
        }
        return reply(res,200,{analysisId:job.id,uploads:job.slots.map(s=>({...s.image,url:new URL(`/v1/uploads/${job.id}/${s.token}`,origin).href}))});
      }
      const match=path.match(/^\/v1\/analyses\/([\w-]+)(\/start)?$/);
      const job=match && jobs.get(match[1]);
      if(!job || job.owner!==session.owner) throw fail(404,'not_found');
      if(req.method==='DELETE' && !match[2]) {job.abort.abort();for(const s of job.slots)s.bytes=undefined;jobs.delete(job.id);return reply(res,200,{});}
      if(req.method==='POST' && match[2]) {
        if(job.status==='pending') {
          if(job.slots.some(s=>!s.bytes || s.uploading)) throw fail(409,'missing_upload');
          charge(job.slots.length); job.status='running'; void run(job);
        }
        return reply(res,202,{});
      }
      if(req.method==='GET' && !match[2]) return reply(res,200,{analysisId:job.id,status:job.status,provider:'plantnet',modelVersion:job.modelVersion,errorCode:job.errorCode,observations:job.observations??[]});
      throw fail(404,'not_found');
    } catch(e) { if(!res.headersSent) reply(res,e.status??500,{errorCode:e.code??'internal_error'}); else res.end(); }
  });
  server.requestTimeout=30000; server.headersTimeout=10000; server.maxConnections=32;
  const timer=setInterval(purge,30000); timer.unref();
  server.on('close',()=>{clearInterval(timer); for(const j of jobs.values())j.abort.abort();});
  return server;
}
if(process.argv[1] && import.meta.url===new URL(`file://${process.argv[1]}`).href) {
  createBackend({baseURL:process.env.BASE_URL,apiKey:process.env.PLANTNET_API_KEY,betaKey:process.env.BETA_ACCESS_KEY,dailyLimit:Number(process.env.DAILY_IMAGE_LIMIT??100)}).listen(Number(process.env.PORT??8080),'0.0.0.0');
}

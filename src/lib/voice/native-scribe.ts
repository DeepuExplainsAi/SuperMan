import { pythonJob } from "@/lib/local/jobs";

/** Stream large multipart uploads without a shell, a temporary credential-bearing command, or loading 2GB into RAM. */
export function nativeScribeJob(audioPath: string, token: string, model: string, opts: { keyterms: string[]; language?: string | null }): string {
  const fields = [["model_id", model], ["diarize", "true"], ["timestamps_granularity", "word"], ["tag_audio_events", "false"],
    ...(opts.language ? [["language_code", opts.language]] : []),
    ...opts.keyterms.filter(t => t.length <= 50 && t.split(/\s+/).length <= 5 && !/[<>{}[\]\\]/.test(t)).slice(0, 100).map(t => ["keyterms", t])];
  return pythonJob(`import http.client, json, os, sys, uuid
from pathlib import Path
from urllib.parse import quote
src, token, fields_raw = json.loads(${JSON.stringify(JSON.stringify([audioPath, token, JSON.stringify(fields)]))})
fields=json.loads(fields_raw)
boundary='om'+uuid.uuid4().hex
prefix=b''
for name,value in fields:
    prefix+=('--'+boundary+'\\r\\nContent-Disposition: form-data; name="'+name+'"\\r\\n\\r\\n'+value+'\\r\\n').encode('utf-8')
prefix+=('--'+boundary+'\\r\\nContent-Disposition: form-data; name="file"; filename="audio"\\r\\nContent-Type: application/octet-stream\\r\\n\\r\\n').encode()
suffix=('\\r\\n--'+boundary+'--\\r\\n').encode()
size=os.path.getsize(src)
Path('out.json.progress').write_text(json.dumps({'state':'transcribing','done':0,'total':size}))
connection=http.client.HTTPSConnection('api.elevenlabs.io',timeout=7200)
try:
    connection.putrequest('POST','/v1/speech-to-text?token='+quote(token,safe=''))
    connection.putheader('Content-Type','multipart/form-data; boundary='+boundary)
    connection.putheader('Content-Length',str(len(prefix)+size+len(suffix)))
    connection.endheaders()
    connection.send(prefix)
    with open(src,'rb') as audio:
        while True:
            chunk=audio.read(1024*1024)
            if not chunk: break
            connection.send(chunk)
    connection.send(suffix)
    response=connection.getresponse()
    if response.status!=200: raise RuntimeError('Transcription provider returned HTTP '+str(response.status))
    with open('out.json.tmp','wb') as output:
        while True:
            chunk=response.read(1024*1024)
            if not chunk: break
            output.write(chunk)
    os.replace('out.json.tmp','out.json')
finally: connection.close()
`);
}

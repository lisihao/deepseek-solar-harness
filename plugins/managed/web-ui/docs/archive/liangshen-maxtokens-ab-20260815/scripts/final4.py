import json,os,re,subprocess,time
from collections import Counter

base=os.path.expanduser('~/.dsh/sessions/--private-tmp--')
rows=[]
for d in os.listdir(base):
    p=os.path.join(base,d,'session.jsonl.zstd')
    if not os.path.exists(p): continue
    rows.append((os.path.getmtime(os.path.join(base,d)), d, p))
rows.sort(reverse=True)
window_start = time.mktime(time.strptime('2026-08-15 21:30:00', '%Y-%m-%d %H:%M:%S'))

def classify(text):
    we=len(re.findall(r'\bwe\b', text, re.I))
    lm=len(re.findall(r'\blet me\b', text, re.I))
    if we>0 and lm==0: return 'minimal-like', we, lm
    if lm>0: return 'standard-like', we, lm
    return 'ambiguous', we, lm

groups = {'baseline': [], 'cap': []}
for mtime, d, p in rows:
    if mtime < window_start: continue
    try:
        raw=subprocess.run(['zstd','-d','-c',p],capture_output=True,text=True,timeout=20).stdout
    except Exception: continue
    first=None; max_tokens=None
    for line in raw.splitlines():
        try: e=json.loads(line)
        except: continue
        t=e.get('type')
        if t=='request/header' and max_tokens is None:
            hdr=e.get('data',{}).get('header',{})
            tl=[x.get('name') for x in hdr.get('tools',[])]
            if tl != ['bash','str_replace_editor']: continue
            max_tokens=hdr.get('config',{}).get('maxTokens')
        if t=='assistant/message' and first is None:
            for b in e.get('data',{}).get('message',{}).get('content',[]):
                if b.get('type')=='reasoning':
                    first=b.get('text',''); break
        if max_tokens is not None and first is not None: break
    if first is None or max_tokens is None: continue
    grp = 'cap' if max_tokens == 1024 else 'baseline'
    label,we,lm = classify(first)
    groups[grp].append({'d': d[:8], 'label': label, 'we': we, 'lm': lm, 'len': len(first), 'mt': max_tokens})

for grp in ['baseline','cap']:
    g = groups[grp]
    n = len(g)
    c = Counter(r['label'] for r in g)
    print(f'=== 官方端点 {grp} (n={n}) ===')
    print(f'  minimal-like: {c.get("minimal-like",0)} ({c.get("minimal-like",0)/n:.0%})  standard-like: {c.get("standard-like",0)}  ambiguous: {c.get("ambiguous",0)}')
    for r in g:
        print(f'    {r["d"]} {r["label"]:13s} we={r["we"]:2d} lm={r["lm"]:2d} mt={r["mt"]}')

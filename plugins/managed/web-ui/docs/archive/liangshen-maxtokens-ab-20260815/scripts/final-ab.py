import json,os,re,subprocess
from collections import Counter

def classify(text):
    we=len(re.findall(r'\bwe\b', text, re.I))
    lm=len(re.findall(r'\blet me\b', text, re.I))
    if we>0 and lm==0: return 'minimal-like', we, lm
    if lm>0: return 'standard-like', we, lm
    return 'ambiguous', we, lm

base=os.path.expanduser('~/.dsh/sessions/--private-tmp--')
rows=[]
for d in os.listdir(base):
    p=os.path.join(base,d,'session.jsonl.zstd')
    if not os.path.exists(p): continue
    mtime=os.path.getmtime(os.path.join(base,d))
    rows.append((mtime, d, p))
rows.sort(reverse=True)

# 实验窗口：21:17 之后（批量脚本启动时间）
import time
window_start = time.mktime(time.strptime('2026-08-15 21:17:00', '%Y-%m-%d %H:%M:%S'))
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
            if tl != ['bash','str_replace_editor']: break
            max_tokens=hdr.get('config',{}).get('maxTokens')
        if t=='assistant/message' and first is None:
            for b in e.get('data',{}).get('message',{}).get('content',[]):
                if b.get('type')=='reasoning':
                    first=b.get('text',''); break
        if max_tokens is not None and first is not None: break
    if first is None or max_tokens is None: continue
    label,we,lm=classify(first)
    grp = 'cap' if max_tokens == 1024 else 'baseline'
    groups[grp].append({'d': d[:8], 'label': label, 'we': we, 'lm': lm, 'len': len(first)})

for grp in ['baseline','cap']:
    rows2 = groups[grp]
    c = Counter(r['label'] for r in rows2)
    n = len(rows2)
    print(f'=== {grp} (n={n}) ===')
    print(f'  minimal-like (we): {c.get("minimal-like",0)} ({c.get("minimal-like",0)/n:.0%})')
    print(f'  standard-like (let me): {c.get("standard-like",0)}')
    print(f'  ambiguous: {c.get("ambiguous",0)}')
    for r in rows2:
        print(f'    {r["d"]} {r["label"]:13s} we={r["we"]:2d} lm={r["lm"]:2d} len={r["len"]}')

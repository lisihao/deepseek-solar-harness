import json,os,re,subprocess,time
from collections import Counter

base=os.path.expanduser('~/.dsh/sessions/--private-tmp--')
rows=[]
for d in os.listdir(base):
    p=os.path.join(base,d,'session.jsonl.zstd')
    if not os.path.exists(p): continue
    rows.append((os.path.getmtime(os.path.join(base,d)), d, p))
rows.sort(reverse=True)
window_start = time.mktime(time.strptime('2026-08-15 21:17:00', '%Y-%m-%d %H:%M:%S'))

def classify(text):
    we=len(re.findall(r'\bwe\b', text, re.I))
    lm=len(re.findall(r'\blet me\b', text, re.I))
    if we>0 and lm==0: return 'minimal-like'
    if lm>0: return 'standard-like'
    return 'ambiguous'

groups = {'baseline': [], 'cap': []}
for mtime, d, p in rows:
    if mtime < window_start: continue
    try:
        raw=subprocess.run(['zstd','-d','-c',p],capture_output=True,text=True,timeout=20).stdout
    except Exception: continue
    first=None; max_tokens=None; events=[]
    for line in raw.splitlines():
        try: e=json.loads(line)
        except: continue
        events.append(e)
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
    # 跳过 OK 验证任务
    if 'Reply with exactly' in first: continue
    grp = 'cap' if max_tokens == 1024 else 'baseline'
    # 晋升后 reasoning 统计：找晋升（run_code header）后的 assistant reasoning 块
    post = []
    seen_promoted = False
    for e in events:
        if e.get('type')=='request/header':
            tl=[x.get('name') for x in e.get('data',{}).get('header',{}).get('tools',[])]
            if tl == ['run_code']: seen_promoted = True
        if seen_promoted and e.get('type')=='assistant/message':
            for b in e.get('data',{}).get('message',{}).get('content',[]):
                if b.get('type')=='reasoning': post.append(b.get('text',''))
    post_labels = Counter(classify(t) for t in post[:3])
    groups[grp].append({'d': d[:8], 'label': classify(first), 'we_count': len(re.findall(r'\bwe\b',first,re.I)), 'post': dict(post_labels), 'post_n': len(post)})

for grp in ['baseline','cap']:
    g = groups[grp]
    n = len(g)
    c = Counter(r['label'] for r in g)
    print(f'=== {grp} (n={n}) ===')
    print(f'  首块 minimal-like: {c.get("minimal-like",0)}/{n} ({c.get("minimal-like",0)/n:.0%})  standard-like: {c.get("standard-like",0)}  ambiguous: {c.get("ambiguous",0)}')
    post_all = Counter()
    for r in g:
        for k,v in r['post'].items(): post_all[k] += v
    total_post = sum(post_all.values())
    print(f'  晋升后前3块 reasoning (n={total_post}): {dict(post_all)}')

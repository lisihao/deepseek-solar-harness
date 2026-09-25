import json,os,re,subprocess,glob,sys

def classify(text):
    we=len(re.findall(r'\bwe\b', text, re.I))
    lm=len(re.findall(r'\blet me\b', text, re.I))
    if we>0 and lm==0: return 'minimal-like', we, lm
    if lm>0: return 'standard-like', we, lm
    return 'ambiguous', we, lm

# 收集所有 headless 测试会话（按 mtime 排序，取最近的）
base=os.path.expanduser('~/.dsh/sessions/--private-tmp--')
sessions=[]
for d in os.listdir(base):
    p=os.path.join(base,d,'session.jsonl.zstd')
    if not os.path.exists(p): continue
    mtime=os.path.getmtime(os.path.join(base,d))
    sessions.append((mtime, d, p))
sessions.sort(reverse=True)

# 只分析实验窗口内的（最近 25 个，排除之前验证用的）
results=[]
for mtime, d, p in sessions[:25]:
    try:
        raw=subprocess.run(['zstd','-d','-c',p],capture_output=True,text=True,timeout=20).stdout
    except Exception:
        continue
    first=None; max_tokens=None; tools=None; next_tools=None; next_tokens=None
    for line in raw.splitlines():
        try: e=json.loads(line)
        except: continue
        t=e.get('type')
        if t=='request/header':
            hdr=e.get('data',{}).get('header',{})
            tl=[x.get('name') for x in hdr.get('tools',[])]
            mt=hdr.get('config',{}).get('maxTokens')
            if tools is None:
                tools=tl; max_tokens=mt
            elif next_tools is None:
                next_tools=tl; next_tokens=mt
        if t=='assistant/message' and first is None:
            for b in e.get('data',{}).get('message',{}).get('content',[]):
                if b.get('type')=='reasoning':
                    first=b.get('text',''); break
    if first is None: continue
    label,we,lm=classify(first)
    results.append({'session': d[:8], 'tools': tools, 'maxTokens': max_tokens,
                    'label': label, 'we': we, 'letMe': lm, 'len': len(first),
                    'nextTools': next_tools, 'nextTokens': next_tokens})
    print(f"{d[:8]} tools={tools} maxTokens={max_tokens} label={label} we={we} lm={lm} next={next_tools} nextTok={next_tokens}")

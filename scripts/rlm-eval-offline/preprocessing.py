"""Frozen offline baseline preparation using local SQLite FTS5 and fake calls."""
import hashlib
import json
import re
import sqlite3
from arm_adapter import ScriptedFakeProvider

def sha(value):
    return hashlib.sha256(value).hexdigest()

def pack_records(records, count_tokens, tokenizer_id, limit=8192):
    """Keep every audited original record; oversized records stay whole."""
    if not records or not tokenizer_id or type(limit) is not int or limit <= 0:
        raise ValueError('Original records and explicit tokenizer/version/cap required')
    chunks, current, start, cursor = [], b'', 0, 0
    for record in records:
        if not isinstance(record, bytes) or not record:
            raise ValueError('Complete nonempty original record bytes required')
        record.decode('utf8', errors='strict')
        candidate = current + record
        tokens = count_tokens(candidate)
        if type(tokens) is not int or tokens < 0:
            raise ValueError('Tokenizer must return exact nonnegative count')
        if current and tokens > limit:
            chunks.append(current); start += len(current); current = b''
        current += record
        cursor += len(record)
    if current:
        chunks.append(current)
    offset, result = 0, []
    for chunk in chunks:
        tokens = count_tokens(chunk)
        if type(tokens) is not int or tokens < 0:
            raise ValueError('Exact final chunk token count required')
        result.append(dict(start=offset, end=offset+len(chunk), sha256=sha(chunk), text=chunk.decode('utf8'),
                           tokens=tokens, oversized=tokens > limit, tokenizer=tokenizer_id))
        offset += len(chunk)
    if offset != cursor:
        raise ValueError('Original tail coverage differs')
    return result

def bm25(records, question, top_k=5):
    """SQLite FTS5 BM25: k1=1.2, b=.75, unicode61, stable original-index ties.

    Source: https://www.sqlite.org/fts5.html#the_bm25_function . SQLite returns
    lower scores for better matches. The query uses quoted Unicode word ORs.
    """
    if type(top_k) is not int or top_k <= 0 or not isinstance(question, str):
        raise ValueError('Explicit positive top-k and question required')
    terms = list(dict.fromkeys(re.findall(r'\w+', question, flags=re.UNICODE)))
    if not terms:
        raise ValueError('Question has no FTS query terms')
    with sqlite3.connect(':memory:') as db:
        db.execute("CREATE VIRTUAL TABLE corpus USING fts5(text, tokenize='unicode61')")
        for index, record in enumerate(records):
            if not isinstance(record, bytes):
                raise ValueError('Original record bytes required')
            db.execute('INSERT INTO corpus(rowid,text) VALUES (?,?)', (index+1, record.decode('utf8', errors='strict')))
        query = ' OR '.join('"' + term.replace('"', '""') + '"' for term in terms)
        selected = db.execute('SELECT rowid,text,bm25(corpus) FROM corpus WHERE corpus MATCH ? ORDER BY bm25(corpus),rowid LIMIT ?',
                              (query, top_k)).fetchall()
        source_id = db.execute('SELECT sqlite_source_id()').fetchone()[0]
    return dict(implementation='sqlite-fts5-bm25', sqlite=sqlite3.sqlite_version, source_id=source_id,
                tokenizer='unicode61', k1=1.2, b=.75, top_k=top_k, query=query,
                matches=[dict(index=rowid-1, text=text, sha256=sha(text.encode()), score=score) for rowid,text,score in selected])

def prepare_baseline(kind, chunks, provider, budget):
    """Consume every fixed chunk in order; fail when any fake call cannot finish."""
    if kind not in ('summary', 'fixed-map-reduce') or not chunks or not isinstance(provider, ScriptedFakeProvider):
        raise ValueError('Explicit fake provider and complete frozen chunks required')
    original = b''.join(c['text'].encode('utf8') for c in chunks)
    offset = 0
    for chunk in chunks:
        raw = chunk['text'].encode('utf8')
        if chunk['start'] != offset or chunk['end'] != offset+len(raw) or chunk['sha256'] != sha(raw):
            raise ValueError('Chunk order, coverage or original byte digest mismatch')
        offset += len(raw)
    outputs, calls = [], []
    def call(request, category):
        body = json.dumps(request, ensure_ascii=False, sort_keys=True).encode()
        key = 'fake-preprocess-' + str(budget.attempts+1)
        budget.admit(key, body, len(body), min(1024, budget.caps.per_request_output), category)
        result = provider.next(request)
        if set(result) != {'text'} or not isinstance(result['text'], str) or not result['text']:
            budget.settle(key, None)
            raise ValueError('Incomplete fake preprocessing output; reservation retained')
        budget.settle(key, dict(input=len(body), output=len(json.dumps(result).encode()), reasoning_included=True))
        calls.append(dict(request=request, output=result))
        return result['text']
    for chunk in chunks:
        if kind == 'fixed-map-reduce':
            budget.spawn('root-only', 0)
        outputs.append(call(dict(operation=kind, stage='map', original_chunk=chunk),
                            'child' if kind == 'fixed-map-reduce' else 'tool-round'))
    result = call(dict(operation=kind, stage='reduce', maps=outputs), 'root')
    return dict(kind=kind, context_sha256=sha(original), chunks=chunks, calls=calls, text=result, fake_only=True)

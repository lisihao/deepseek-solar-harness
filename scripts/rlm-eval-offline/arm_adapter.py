"""Network-free experimental arm preparation and common fake code loop.

The loop accepts only ScriptedFakeProvider. It demonstrates context placement,
state retention and host-owned spawn policy without providing a paid launcher.
Production DSH transport, tokenizer and isolation proofs remain separate inputs.
"""
from copy import deepcopy
from dataclasses import dataclass
import hashlib
import json
import signal
import time
from budget import OfflineBudget, BudgetExceeded

@dataclass(frozen=True)
class Arm:
    context: str
    spawn: str
    preprocessing: str
    code_tools: bool = True

ARMS = {
    'direct': Arm('full', 'none', 'none', False),
    'codeact_bm25': Arm('full', 'none', 'bm25'),
    'codeact_subcalls': Arm('full', 'root-only', 'none'),
    'summary': Arm('summary', 'none', 'summary'),
    'chunk_map_reduce': Arm('chunks', 'root-only', 'fixed-map-reduce'),
    'rlm_nosub': Arm('external', 'none', 'none'),
    'rlm_flat': Arm('external', 'root-only', 'none'),
    'rlm_full': Arm('external', 'recursive', 'none'),
}

class ScriptedFakeProvider:
    def __init__(self, steps):
        self.steps, self.inputs = list(steps), []

    def next(self, value):
        self.inputs.append(deepcopy(value))
        if not self.steps:
            raise ValueError('Fake script exhausted; no fallback provider')
        return deepcopy(self.steps.pop(0))

class OfflineCodeLoop:
    """One code/file loop for strong baselines and RLM; only spawn policy differs."""
    def __init__(self, arm, question, context, provider, budget=None, depth=0, preparation=None, records=None):
        if arm not in ARMS or not isinstance(provider, ScriptedFakeProvider):
            raise ValueError('Known arm and explicit scripted fake provider required')
        if not isinstance(question, str) or not isinstance(context, str):
            raise ValueError('Complete UTF8 question and context required')
        self.arm, self.spec, self.question = arm, ARMS[arm], question
        self.raw, self.context = context.encode('utf8', errors='strict'), context
        self.provider, self.budget, self.depth = provider, budget or OfflineBudget(), depth
        self.records = tuple(records) if records is not None else (self.raw,)
        if b''.join(self.records) != self.raw:
            raise ValueError('Original record list must cover the complete context')
        self.handle = 'context:' + hashlib.sha256(self.raw).hexdigest()
        self.preparation = deepcopy(preparation)
        self.history, self.children = [], []
        self.namespace = {'context': context, 'read_context': self.read, 'spawn': self.spawn, 'search': self.search}

    def read(self, offset, length):
        if type(offset) is not int or type(length) is not int or offset < 0 or not 0 <= length <= self.budget.caps.read_bytes:
            raise ValueError('Exact byte offset and bounded read required')
        return self.raw[offset:offset + length].decode('utf8', errors='strict')

    def search(self, question):
        from preprocessing import bm25
        return bm25(self.records, question)

    def spawn(self, steps):
        depth = self.budget.spawn(self.spec.spawn, self.depth)
        child = OfflineCodeLoop(self.arm, self.question, self.context, ScriptedFakeProvider(steps), self.budget, depth,
                                records=self.records)
        self.children.append(child)
        return child.run()

    def request(self):
        if self.spec.preprocessing not in ('none', 'bm25'):
            if (not isinstance(self.preparation, dict) or self.preparation.get('kind') != self.spec.preprocessing
                    or self.preparation.get('context_sha256') != hashlib.sha256(self.raw).hexdigest()
                    or self.preparation.get('fake_only') is not True or not isinstance(self.preparation.get('text'), str)):
                raise ValueError('Frozen ' + self.spec.preprocessing + ' preprocessing evidence required; no silent substitute')
        material = {'context': self.context} if self.spec.context == 'full' else {
            'context_handle': self.handle, 'context_bytes': len(self.raw)}
        if self.preparation is not None:
            material['prepared_context'] = self.preparation['text']
            material['preparation_sha256'] = hashlib.sha256(json.dumps(self.preparation, sort_keys=True).encode()).hexdigest()
        return {'arm': self.arm, 'question': self.question, **material, 'depth': self.depth,
                'spawn_policy': self.spec.spawn, 'tools': ['run_code'] if self.spec.code_tools else [],
                'history': deepcopy(self.history)}

    def cell(self, source):
        if not self.spec.code_tools or not isinstance(source, str):
            raise ValueError('Code tool unavailable or invalid code')
        self.budget.cell()
        # Only trusted, checked-in fake cells run here. This timer is a fixture
        # wall-time limit, not an isolation claim against hostile model code.
        def timeout(_signum, _frame):
            raise BudgetExceeded('REPL cell wall-time cap')
        previous = signal.signal(signal.SIGALRM, timeout)
        previous_timer = signal.getitimer(signal.ITIMER_REAL)
        started = time.monotonic()
        limit = min(self.budget.caps.cell_seconds, previous_timer[0]) if previous_timer[0] > 0 else self.budget.caps.cell_seconds
        signal.setitimer(signal.ITIMER_REAL, limit)
        try:
            self.namespace.pop('result', None)
            exec(compile(source, '<offline-fake-cell>', 'exec'), self.namespace)
            value = self.namespace.get('result')
            if not isinstance(value, str):
                raise ValueError('Fake cell must produce explicit result text')
            return value
        finally:
            signal.setitimer(signal.ITIMER_REAL, 0)
            signal.signal(signal.SIGALRM, previous)
            if previous_timer[0] > 0:
                remaining = max(0.000001, previous_timer[0] - (time.monotonic() - started))
                signal.setitimer(signal.ITIMER_REAL, remaining, previous_timer[1])

    def run(self):
        while True:
            request = self.request()
            body = json.dumps(request, ensure_ascii=False, sort_keys=True).encode('utf8')
            request_id = 'fake-' + str(self.budget.attempts + 1)
            # One byte per fake token is a declared fixture bound only.
            self.budget.admit(request_id, body, len(body), min(1024, self.budget.caps.per_request_output),
                              'root' if self.depth == 0 else 'child')
            step = self.provider.next(request)
            output = json.dumps(step, ensure_ascii=False).encode('utf8')
            self.budget.settle(request_id, {'input': len(body), 'output': len(output), 'reasoning_included': True})
            if set(step) == {'final'} and isinstance(step['final'], str):
                return step['final']
            if set(step) != {'code'}:
                raise ValueError('Unknown fake response; no fallback')
            result = self.cell(step['code'])
            self.history.append({'code': step['code'], 'result': result})

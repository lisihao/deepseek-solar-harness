"""Offline candidate budget admission. No transport or launch capability.

This ledger proves the candidate algorithm against fake physical attempts. It is
not a substitute for wiring the same checks into DSH's actual transport/WP1.
"""
from dataclasses import dataclass
import hashlib
import math
import time

@dataclass(frozen=True)
class Caps:
    input_tokens: int = 200000
    output_tokens: int = 16000
    attempts: int = 24
    in_flight: int = 1
    per_request_output: int = 4096
    admission_seconds: int = 1200
    cells: int = 64
    cell_seconds: int = 10
    read_bytes: int = 8192
    depth: int = 2
    children: int = 8

class BudgetExceeded(RuntimeError):
    pass

class OfflineBudget:
    """Reserve before a fake physical attempt; retain all unknown reservations."""
    def __init__(self, caps=Caps(), clock=time.monotonic):
        self.caps, self.clock = caps, clock
        self.started = clock()
        self.input = self.output = self.attempts = self.children = self.cells = 0
        self.requests = {}
        self.bound_violation = False

    def admit(self, request_id, body, proven_input_tokens, max_output, category='root'):
        if self.bound_violation:
            raise BudgetExceeded('Known usage exceeded a reservation; admission stopped')
        if request_id in self.requests:
            raise ValueError('Attempt ID already exists; unknown effects cannot be replayed')
        if not isinstance(body, bytes) or type(proven_input_tokens) is not int or proven_input_tokens < 0:
            raise ValueError('Exact bytes and proven input token bound required')
        if type(max_output) is not int or not 0 < max_output <= self.caps.per_request_output:
            raise ValueError('Explicit bounded max_tokens required')
        if category not in ('root', 'child', 'continuation', 'tool-round', 'retry'):
            raise ValueError('Unknown physical request category')
        active = sum(x['state'] in ('in_flight', 'unknown') for x in self.requests.values())
        if self.clock() - self.started >= self.caps.admission_seconds:
            raise BudgetExceeded('New admission window expired')
        if active >= self.caps.in_flight or self.attempts >= self.caps.attempts:
            raise BudgetExceeded('Physical attempt/in-flight cap')
        if self.input + proven_input_tokens > self.caps.input_tokens or self.output + max_output > self.caps.output_tokens:
            raise BudgetExceeded('Whole-tree token cap')
        self.input += proven_input_tokens
        self.output += max_output
        self.attempts += 1
        self.requests[request_id] = dict(state='in_flight', input=proven_input_tokens, output=max_output,
            body_sha256=hashlib.sha256(body).hexdigest(), category=category, usage=None)

    def settle(self, request_id, usage):
        request = self.requests[request_id]
        if request['state'] == 'settled':
            if request['usage'] != usage:
                raise ValueError('Conflicting settlement')
            return
        if usage is None:
            request['state'] = 'unknown'
            return
        if not isinstance(usage, dict) or usage.get('reasoning_included') is not True:
            raise ValueError('Complete output including reasoning must be known')
        for key in ('input', 'output'):
            if type(usage.get(key)) is not int or usage[key] < 0:
                raise ValueError('Usage absent or invalid')
        self.input -= request['input'] - usage['input']
        self.output -= request['output'] - usage['output']
        request.update(state='settled', usage=dict(usage))
        if usage['input'] > request['input'] or usage['output'] > request['output']:
            self.bound_violation = True
            raise BudgetExceeded('Actual usage charged in full after reservation violation')

    def spawn(self, policy, parent_depth):
        if type(parent_depth) is not int or parent_depth < 0:
            raise ValueError('Exact nonnegative parent depth required')
        if policy not in ('none', 'root-only', 'recursive'):
            raise ValueError('Explicit spawn policy required')
        if policy == 'none' or (policy == 'root-only' and parent_depth != 0):
            raise BudgetExceeded('Spawn denied by host policy')
        if parent_depth >= self.caps.depth or self.children >= self.caps.children:
            raise BudgetExceeded('Cumulative child/depth cap')
        self.children += 1
        return parent_depth + 1

    def cell(self):
        if self.cells >= self.caps.cells:
            raise BudgetExceeded('REPL cell cap')
        self.cells += 1


def quote(caps, trials, prices, proof):
    """Return a conditional offline ceiling only with all named bound evidence."""
    required = ('input_bound', 'reasoning_ceiling', 'physical_transport', 'wp1_integration', 'model_parameters')
    if not all(isinstance(proof.get(k), str) and proof[k] for k in required):
        raise ValueError('Unproven bound or transport/WP1 integration; quotation refused')
    if type(trials) is not int or trials <= 0:
        raise ValueError('Explicit positive trial count required')
    for key in ('input_worst_per_million', 'output_worst_per_million', 'fixed_cost'):
        if type(prices.get(key)) not in (int, float) or not math.isfinite(prices[key]) or prices[key] < 0:
            raise ValueError('Known finite pricing required')
    if not prices.get('model') or not prices.get('source') or not prices.get('as_of') or not prices.get('currency'):
        raise ValueError('Versioned model and dated pricing source required')
    return {'conditional_cost_ceiling': trials * (caps.input_tokens * prices['input_worst_per_million']
        + caps.output_tokens * prices['output_worst_per_million']) / 1000000 + prices['fixed_cost'],
        'currency': prices.get('currency'), 'launchAllowed': False}

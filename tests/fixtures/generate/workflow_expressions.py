"""Regenerate tests/fixtures/workflows/expressions.json from upstream spec-kit.

Usage (from the repo root, with upstream spec-kit installed in the interpreter):
    python tests/fixtures/generate/workflow_expressions.py

Reads the case inputs from tests/fixtures/generate/workflow_expressions_inputs.json
and records what upstream's evaluator returns for each: the value (and str()
of non-string values) or the raised error, plus the condition helpers and the
if/while/do-while validator messages.
"""
import json
import os
import sys

from specify_cli.workflows.base import StepContext
from specify_cli.workflows.expressions import (
    condition_has_malformed_expression_block,
    condition_is_interpolated_to_text,
    condition_is_never_evaluated,
    evaluate_condition,
    evaluate_expression,
    format_condition_correction,
    format_condition_remediation,
)
from specify_cli.workflows.step.do_while import DoWhileStep
from specify_cli.workflows.step.if_then import IfThenStep
from specify_cli.workflows.step.while_loop import WhileStep

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..', '..'))

with open(os.path.join(HERE, 'workflow_expressions_inputs.json'), encoding='utf-8') as fh:
    spec = json.load(fh)

ctx = StepContext(inputs=spec['ctx']['inputs'], steps=spec['ctx']['steps'], run_id='r1')
templates = []
for t in spec['templates']:
    try:
        v = evaluate_expression(t, ctx)
    except Exception as exc:  # noqa: BLE001
        templates.append({'t': t, 'err': f'{type(exc).__name__}: {exc}'})
        continue
    templates.append({'t': t, 'v': v, 's': None if isinstance(v, str) else str(v)})

cond_ctx = StepContext(inputs={'count': 0, 'ready': False, 'name': 'abc', 'tags': ['a']})
classes = {'If': IfThenStep, 'While': WhileStep, 'Do-while': DoWhileStep}
conds = []
for c in spec['conds']:
    try:
        ev = evaluate_condition(c, cond_ctx)
    except Exception as exc:  # noqa: BLE001
        ev = 'ERR ' + type(exc).__name__
    conds.append({
        'c': c,
        'condition_is_never_evaluated': condition_is_never_evaluated(c),
        'condition_is_interpolated_to_text': condition_is_interpolated_to_text(c),
        'condition_has_malformed_expression_block': condition_has_malformed_expression_block(c),
        'format_condition_remediation': format_condition_remediation(c),
        'format_condition_correction': format_condition_correction(c),
        'eval': ev,
        'validate': {
            label: cls().validate({'id': 's', 'condition': c, 'then': [], 'steps': []})
            for label, cls in classes.items()
        },
    })

out = {'conds': conds, 'templates': templates, 'ctx': spec['ctx']}
with open(os.path.join(ROOT, 'tests', 'fixtures', 'workflows', 'expressions.json'), 'w', encoding='utf-8') as fh:
    json.dump(out, fh, indent=1, ensure_ascii=False)
    fh.write('\n')
print(f"{len(templates)} templates, {len(conds)} conditions", file=sys.stderr)

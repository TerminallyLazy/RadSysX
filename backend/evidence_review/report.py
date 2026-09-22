"""Inert local HTML and a positive-only projection for blinded human review."""
import base64
from collections import Counter
import hashlib
import html
import json
import re
from urllib.parse import urlsplit

from .metrics import usage_summary
from .study import study_pairs, validate_study

CSS = """
:root{color-scheme:light dark;--bg:#f5f6f8;--card:#fff;--ink:#172537;--muted:#53657b;--line:#d9e0e8;--accent:#224f75;--mark:#fff0bf}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.6 system-ui,sans-serif}
main{max-width:1100px;margin:auto;padding:48px 24px 80px}header{border-bottom:2px solid var(--ink);padding-bottom:24px;margin-bottom:32px}
h1{font-size:clamp(2rem,5vw,3rem);letter-spacing:-.04em;line-height:1.1;margin:12px 0}h2{font-size:1.35rem}h3{font-size:1.1rem}
.eyebrow{font-size:.75rem;letter-spacing:.14em;text-transform:uppercase;color:var(--accent);font-weight:700}.muted{color:var(--muted)}
article,section.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px;margin:20px 0}
pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:0}pre.technical{font:12px/1.6 ui-monospace,monospace}
mark{background:var(--mark);color:var(--ink);border-radius:2px}a{color:var(--accent);overflow-wrap:anywhere}a:focus,summary:focus{outline:3px solid var(--accent);outline-offset:4px}
summary{cursor:pointer;font-weight:600;padding:10px 0}details{margin:16px 0;border-top:1px solid var(--line)}
.scroll{overflow:auto}table{border-collapse:collapse;width:100%;font-size:.9rem}caption{text-align:left;font-weight:700;padding:12px 0}
th,td{text-align:left;vertical-align:top;border-bottom:1px solid var(--line);padding:12px 14px 12px 0}th{color:var(--muted)}
.badge{display:inline-block;border:1px solid var(--line);padding:3px 10px;border-radius:5px;font-size:.85rem;font-weight:600}.metrics{display:flex;gap:24px;flex-wrap:wrap}.metric strong{display:block;font-size:1.8rem}
.note{border-left:3px solid var(--accent);padding-left:16px}.claim{font-size:1.12rem;line-height:1.65}footer{margin-top:32px;color:var(--muted);font-size:.85rem}
@media(prefers-color-scheme:dark){:root{--bg:#111923;--card:#182331;--ink:#e3eaf2;--muted:#a3b4c6;--line:#35465b;--accent:#9fccec;--mark:#524723}}
@media(max-width:600px){main{padding:24px 14px}article,section.card{padding:18px}.metrics{gap:16px}}
""".strip()


def text_node(value):
    return html.escape(str(value),quote=True)


def validated_source_url(url: str, *, synthetic=False) -> str:
    if re.fullmatch(r'https://pubmed\.ncbi\.nlm\.nih\.gov/[0-9]{1,12}/',url):
        return url
    parsed = urlsplit(url)
    if (synthetic and parsed.scheme=='https' and parsed.hostname in {'example.com','example.org','example.test'}
            and parsed.netloc==parsed.hostname and not parsed.query and not parsed.fragment
            and not any(ord(c)<33 for c in url) and '\\' not in url):
        return url
    raise ValueError('unsafe_source_url')


def source_anchor(url,title, *, synthetic=False):
    try:
        safe = validated_source_url(url,synthetic=synthetic)
    except ValueError:
        return text_node(title)+' (link omitted)'
    return f'<a href="{text_node(safe)}" rel="noreferrer noopener">{text_node(title)}</a>'


def _page(title,subtitle,body):
    style_hash = base64.b64encode(hashlib.sha256(CSS.encode()).digest()).decode()
    csp = "default-src 'none'; base-uri 'none'; form-action 'none'; script-src 'none'; connect-src 'none'; img-src 'none'; font-src 'none'; style-src 'sha256-"+style_hash+"'"
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
        f'<meta http-equiv="Content-Security-Policy" content="{text_node(csp)}"><title>{text_node(title)}</title><style>{CSS}</style></head>'
        f'<body><main><header><div class="eyebrow">RadSysX · Evidence review</div><h1>{text_node(title)}</h1><p class="muted">{text_node(subtitle)}</p></header>'
        +body+'<footer>Local evaluation artifact. Source links open only when selected. No result changes the original answer.</footer></main></body></html>')


def _details(title,data):
    return f'<details><summary>{text_node(title)}</summary><pre class="technical">{text_node(json.dumps(data,ensure_ascii=False,indent=2))}</pre></details>'


def _evidence(evidence, *, synthetic=False):
    sections = ''.join((f'<h3>{text_node(s["label"])}</h3>' if s['label'] else '')+f'<pre>{text_node(s["text"])}</pre>' for s in evidence['sections'])
    return (f'<p>{source_anchor(evidence["url"],evidence["title"],synthetic=synthetic)}</p>'
        f'<p class="muted">Abstract availability: {text_node(evidence["completeness"])}</p>'+sections)


def blind_projection(manifest,snapshots):
    validation = validate_study(manifest,snapshots,require_target=False)
    if not validation.input_ready:
        raise ValueError('invalid_blind_study')
    pairs = study_pairs(manifest,snapshots)
    cases = []
    for case in manifest.cases:
        pair = pairs[(case.snapshot_sha256,case.pair_id)]
        evidence = pair.evidence
        cases.append({'case_id':case.case_id,'pair_hash':case.pair_hash,'claim':pair.unit.text,
            'citations':[span.source_id for span in pair.unit.citation_spans],
            'evidence':{'title':evidence.title,'url':validated_source_url(evidence.url,synthetic=evidence.source_kind=='synthetic'),
                'sections':[{'label':s.label,'text':s.text} for s in evidence.sections],'completeness':evidence.completeness},
            'data_class':snapshots[case.snapshot_sha256].data_class,'origin':case.origin})
    return {'schema_version':1,'cases':cases}


def render_blind(data):
    body = ('<p class="note">Review each exact claim against its cited abstract only. Do not use outside evidence. '
        'Complete your own review before discussing cases. Constructed claims are test material, not quotations from a paper.</p>')
    for case in data['cases']:
        body += (f'<article><div class="eyebrow">{text_node(case["case_id"])} · {text_node(case["data_class"])} · {text_node(case["origin"])}</div>'
            f'<h2>Claim</h2><pre class="claim">{text_node(case["claim"])}</pre><h2>Cited abstract</h2>'
            +_evidence(case['evidence'],synthetic=case['data_class']=='synthetic')
            +_details('Reference identity',{'case_id':case['case_id'],'pair_hash':case['pair_hash']})+'</article>')
    from .rubric import RELATIONSHIP_CRITERIA
    body += '<section class="card"><h2>Review labels</h2>'+''.join(f'<p><strong>{text_node(label)}</strong> — {text_node(definition)}</p>' for label,definition in RELATIONSHIP_CRITERIA.items())+'</section>'
    return _page('Independent evidence review',f'{len(data["cases"])} cases · Blinded reviewer packet',body)


def _answer(snapshot,plan):
    cursor = 0; pieces = []
    for unit in sorted(plan.units,key=lambda u:u.start):
        pieces.append(text_node(snapshot.result.summary[cursor:unit.start]))
        pieces.append('<mark>'+text_node(snapshot.result.summary[unit.start:unit.end])+'</mark>')
        cursor = unit.end
    pieces.append(text_node(snapshot.result.summary[cursor:]))
    return '<pre id="original-answer">'+''.join(pieces)+'</pre>'


def render_run(snapshot,plan,run):
    if snapshot.snapshot_sha256 != plan.snapshot_sha256 or plan.snapshot_sha256 != run.snapshot_sha256:
        raise ValueError('report_identity_mismatch')
    statuses = Counter(a.status for a in run.assessments)
    accounting = usage_summary(run.attempts,pricing=None)
    body = '<p class="note">Model judgments describe the relationship to one abstract. They do not establish clinical correctness. Keep this report separate from blinded reviewers until references are frozen.</p>'
    body += '<section class="card"><div class="metrics">'+''.join(f'<div class="metric"><strong>{value}</strong>{text_node(name)}</div>' for name,value in [
        ('review units',len(plan.units)),('planned pairs',len(plan.pairs)),('completed pairs',statuses['completed']),('excluded pairs',len(plan.excluded_pairs))])+'</div>'
    body += f'<p>Elapsed: {run.elapsed_seconds:.3f} s · Known cost: Unknown (no declared price table).</p>'+_details('Usage and execution statuses',{'statuses':dict(statuses),'accounting':accounting})+'</section>'
    body += '<section class="card"><h2>Original answer</h2>'+_answer(snapshot,plan)+'</section>'
    index = {p.pair_id:p for p in plan.pairs}
    for assessment in run.assessments:
        pair = index[assessment.pair_id]
        label = assessment.judgment.label if assessment.judgment else assessment.status
        body += f'<article><span class="badge">{text_node(label)}</span><p class="muted">Relative to this abstract · {text_node(assessment.reason or "completed")}</p><pre class="claim">{text_node(pair.unit.text)}</pre>'
        body += _evidence({'title':pair.evidence.title,'url':pair.evidence.url,'completeness':pair.evidence.completeness,
                          'sections':[{'label':s.label,'text':s.text} for s in pair.evidence.sections]},synthetic=snapshot.data_class=='synthetic')
        body += _details('Judgment, provenance and timing',assessment.model_dump(mode='json'))+'</article>'
    body += _details('Coverage and exclusions',{'coverage':[c.model_dump(mode='json') for c in plan.coverage],'excluded_pairs':[e.model_dump(mode='json') for e in plan.excluded_pairs]})
    body += _details('Run identities and limits',{'run_id':run.run_id,'snapshot_sha256':snapshot.snapshot_sha256,'evaluator':run.evaluator,
        'model':run.model,'experiment_sha256':run.experiment_sha256,'limits':run.limits.model_dump(mode='json'),'evaluator_failure':run.evaluator_failure})
    return _page('Abstract review results',f'{run.evaluator} · {run.model} · {snapshot.data_class}',body)


def render_comparison(comparison):
    data = comparison.model_dump(mode='json')
    body = '<p class="note">Paired results use the same cases with resolved human references and completed model responses. Whole-workload counts retain failures and missing reviews. Unavailable metrics are not zero error.</p>'
    body += '<section class="card"><div class="scroll"><table><caption>Whole-workload comparison</caption><thead><tr><th>Evaluator</th><th>Reference cases completed</th><th>Accuracy</th><th>Incorrect support</th><th>Unreviewed reference contradictions</th></tr></thead><tbody>'
    def fraction(value):
        return 'Unavailable' if value['value'] is None else f'{value["numerator"]}/{value["denominator"]} ({value["value"]:.1%})'
    for name,metrics in data['evaluators'].items():
        body += '<tr>'+''.join(f'<td>{text_node(value)}</td>' for value in [name,metrics['completed_reference_cases'],fraction(metrics['classification']['accuracy']),
            fraction(metrics['classification']['incorrect_support']),metrics['unreviewed_reference_contradictions']])+'</tr>'
    body += '</tbody></table></div></section>'
    body += _details('Paired differences and uncertainty intervals',data['paired'])
    body += _details('Per-evaluator metrics, workload, latency and cost',data['evaluators'])
    body += _details('Aligned cases and unresolved references',{'cases':data['rows'],'unresolved':data['unresolved_exclusions']})
    body += _details('Frozen study and experiment',{'reference_sha256':data['reference_sha256'],'experiment_sha256':data['experiment_sha256'],**data['metadata']})
    return _page('Evaluator comparison','Frozen human references · No automatic promotion',body)

import asyncio
from html.parser import HTMLParser

import pytest

from backend.evidence_review.contracts import Limits,freeze_snapshot
from backend.evidence_review.units import build_review_plan
from backend.evidence_review.serialization import canonical_json


def tiny_manifest(snap):
    from backend.evidence_review.study import StudyCase,StudyManifest
    pair=build_review_plan(snap,limits=Limits()).pairs[0]
    return StudyManifest(version='fixture',cases=(StudyCase(case_id='case-1',snapshot_sha256=snap.snapshot_sha256,
        unit_id=pair.unit.unit_id,evidence_id=pair.evidence.evidence_id,pair_id=pair.pair_id,pmid=None,
        topic_family='fixture',partition='development',origin='constructed'),))


class Page(HTMLParser):
    def __init__(self): super().__init__(convert_charrefs=True); self.tags=[]; self.attrs=[]; self.answer=[]; self.in_answer=False
    def handle_starttag(self,tag,attrs):
        self.tags.append(tag); self.attrs.extend(attrs)
        if dict(attrs).get('id')=='original-answer': self.in_answer=True
    def handle_endtag(self,tag):
        if tag=='pre': self.in_answer=False
    def handle_data(self,data):
        if self.in_answer: self.answer.append(data)


def test_blind_positive_projection_and_inert_markup(payload_factory):
    from backend.evidence_review.report import blind_projection,render_blind
    payload=payload_factory(abstract='<img src="https://example.com/pixel"> </script> café & α')
    payload['result']['suggestionsHtml']='<script>MODEL_JUDGMENT_CANARY</script>'
    payload['generation']['model_prediction']='MODEL_JUDGMENT_CANARY'
    snap=freeze_snapshot(payload,limits=Limits())
    data=blind_projection(tiny_manifest(snap),{snap.snapshot_sha256:snap})
    html=render_blind(data); page=Page(); page.feed(html)
    assert '&lt;img' in html and 'img' not in page.tags and 'script' not in page.tags
    assert any("default-src 'none'" in value for name,value in page.attrs if name=="content")
    assert 'MODEL_JUDGMENT_CANARY' not in html+canonical_json(data).decode()
    assert 'suggestionsHtml' not in canonical_json(data).decode()
    assert all(name not in {'src','srcset','onload','onclick'} for name,value in page.attrs)
    assert set(data['cases'][0])=={'case_id','pair_hash','claim','citations','evidence','data_class','origin'}


@pytest.mark.parametrize('url',['javascript:alert(1)','data:text/html,bad','https://user@example.com/a',
    'https://pubmed.ncbi.nlm.nih.gov/123/?redirect=bad','http://example.com/a','https://evil.test/a'])
def test_unsafe_source_urls(url):
    from backend.evidence_review.report import validated_source_url
    with pytest.raises(ValueError): validated_source_url(url,synthetic=True)


def test_original_unicode_answer_roundtrips(snapshot_factory,tmp_path):
    from backend.evidence_review.report import render_run
    from backend.evidence_review.runner import evaluate_snapshot
    from backend.evidence_review.artifacts import ArtifactStore
    from backend.tests.evidence_review.test_runner import ScriptedEvaluator
    async def scenario():
        snap=snapshot_factory(answer='α😀 claim <safe> [s1].\n\nUncited & exact.')
        plan=build_review_plan(snap,limits=Limits())
        with ArtifactStore.create(tmp_path/'private',run_id='report') as store:
            run=await evaluate_snapshot(snap,plan,adapter=ScriptedEvaluator(),store=store,limits=Limits(),cancel=asyncio.Event())
            html=render_run(snap,plan,run); page=Page(); page.feed(html)
            assert ''.join(page.answer)==snap.result.summary
            assert 'Relative to this abstract' in html and 'Unknown' in html and 'details' in page.tags
            assert 'overall verified' not in html.lower()
    asyncio.run(scenario())

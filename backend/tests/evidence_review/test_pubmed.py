"""Original abstracts only: fixed transport, complete XML, no URL or entity expansion."""
import asyncio
import httpx
import pytest
from backend.evidence_review.contracts import Limits, Source

SOURCES = (Source(id='s1', title='Public fixture', url='https://pubmed.ncbi.nlm.nih.gov/123/'),)


def article(text='Finding &amp; naïve ≤6 mm.', pmid='123'):
    return f'<PubmedArticle><MedlineCitation><PMID>{pmid}</PMID><Article><Abstract><AbstractText Label="RESULTS">{text}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle>'


def xml(content=None, prefix=''):
    return (prefix + '<PubmedArticleSet>' + (article() if content is None else content) + '</PubmedArticleSet>').encode()


@pytest.mark.parametrize('url', ['http://pubmed.ncbi.nlm.nih.gov/123/', 'https://pubmed.ncbi.nlm.nih.gov.evil.test/123/',
    'https://user@pubmed.ncbi.nlm.nih.gov/123/', 'https://pubmed.ncbi.nlm.nih.gov/123/?x=1',
    'https://127.0.0.1/123/', 'https://pubmed.ncbi.nlm.nih.gov/123/#abstract', 'https://pubmed.ncbi.nlm.nih.gov/123/\n'])
def test_noncanonical_urls(url):
    from backend.evidence_review.pubmed import canonical_pmid
    assert canonical_pmid(url) is None


def test_original_text_and_ordinary_doctype():
    from backend.evidence_review.pubmed import parse_pubmed_xml
    evidence, exclusions = parse_pubmed_xml(xml(prefix='<!DOCTYPE PubmedArticleSet SYSTEM "https://example.invalid/pubmed.dtd">'), SOURCES, limits=Limits())
    assert not exclusions
    assert evidence[0].sections[0].text == 'Finding & naïve ≤6 mm.'
    assert evidence[0].sections[0].label == 'RESULTS'
    assert evidence[0].completeness == 'complete' and evidence[0].pmid == '123'


@pytest.mark.parametrize('content,status', [(article(''),'absent'), (article('x'*10001),'truncated'),
    (article(pmid='124'),'unavailable'), (article()+article('Different'),'unavailable'),
    (article().replace('<Abstract>', '<Abstract>'+'<AbstractText>x</AbstractText>'*65),'unavailable')], ids=['empty','truncated','wrong-pmid','duplicate','section-limit'])
def test_incomplete_and_ambiguous_abstracts(content,status):
    from backend.evidence_review.pubmed import parse_pubmed_xml
    evidence, _ = parse_pubmed_xml(xml(content), SOURCES, limits=Limits())
    assert evidence[0].completeness == status
    if status == 'truncated': assert sum(len(s.text) for s in evidence[0].sections) == 10000


@pytest.mark.parametrize('body', [b'<!DOCTYPE PubmedArticleSet [<!ENTITY x "secret">]><PubmedArticleSet>&x;</PubmedArticleSet>',
    b'<!DOCTYPE PubmedArticleSet [<!ENTITY x SYSTEM "file:///private">]><PubmedArticleSet>&x;</PubmedArticleSet>',
    b'<a>'*65+b'</a>'*65, b'<bad>', b'x'*(2097152+1)], ids=['internal-entity','external-entity','depth','malformed','size'])
def test_hostile_xml_is_unavailable(body):
    from backend.evidence_review.pubmed import parse_pubmed_xml
    evidence, exclusions = parse_pubmed_xml(body, SOURCES, limits=Limits())
    assert evidence[0].completeness == 'unavailable' and not evidence[0].sections
    assert exclusions[0].reason == 'invalid_pubmed_xml'


@pytest.mark.parametrize('status', [200,302,500])
def test_fixed_origin_bounded_transport(status):
    from backend.evidence_review.pubmed import fetch_pubmed_evidence
    async def scenario():
        requests=[]
        def handler(request):
            requests.append(request)
            assert str(request.url).split('?')[0] == 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'
            assert request.url.params['id'] == '123'
            assert request.url.params['db'] == 'pubmed' and request.url.params['retmode'] == 'xml'
            return httpx.Response(status, content=xml(), headers={'location':'http://127.0.0.1/private'})
        sources = SOURCES + (Source(id='s2', title='Duplicate', url=SOURCES[0].url), Source(id='s3',title='Unsafe',url='http://127.0.0.1/'))
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler), follow_redirects=True) as client:
            evidence, exclusions = await fetch_pubmed_evidence(sources, client=client, limits=Limits(), before_request=lambda:None)
        assert len(requests)==1 and len(evidence)==2
        assert all(e.completeness==('complete' if status==200 else 'unavailable') for e in evidence)
        assert any(e.citation_id=='s3' and e.reason=='non_pubmed_source' for e in exclusions)
    asyncio.run(scenario())


def test_guard_prevents_http_request():
    from backend.evidence_review.pubmed import fetch_pubmed_evidence
    async def scenario():
        def unexpected(request): raise AssertionError('HTTP after revocation')
        async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
            with pytest.raises(ValueError, match='review_authority_changed'):
                await fetch_pubmed_evidence(SOURCES,client=client,limits=Limits(),before_request=lambda:'expired')
    asyncio.run(scenario())

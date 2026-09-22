"""Fixed-origin public abstract retrieval; no model-supplied URL is requested."""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Callable
from xml.etree.ElementTree import TreeBuilder
from xml.parsers import expat

import httpx

from .capture_worker import EvidenceCollector
from .contracts import CaptureExclusion, Evidence, Limits, Source
from .serialization import canonical_json, sha256_bytes

PMID_URL = re.compile(r'https://pubmed\.ncbi\.nlm\.nih\.gov/([0-9]{1,12})/\Z')
EFETCH = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi'


def canonical_pmid(url: str) -> str | None:
    match = PMID_URL.fullmatch(url)
    return match.group(1) if match else None


def _evidence_id(source: Source) -> str:
    # A stored answer may cite one PMID through multiple source aliases.
    return 'e-'+sha256_bytes(canonical_json([source.id,source.url]))[:24]


def _unavailable(source: Source) -> Evidence:
    return Evidence(evidence_id=_evidence_id(source),
        citation_id=source.id, source_kind='pubmed_abstract', pmid=canonical_pmid(source.url),
        url=source.url, title=source.title, retrieved_at=datetime.now(timezone.utc), sections=(),
        extraction_version='ncbi-abstract-v1', text_sha256=sha256_bytes(canonical_json([])),
        completeness='unavailable', original_chars=None)


def _parse(body: bytes, maximum: int):
    if len(body) > maximum: raise ValueError('invalid_pubmed_xml')
    builder = TreeBuilder()
    parser = expat.ParserCreate()
    depth = nodes = 0
    def reject(*args): raise ValueError('invalid_pubmed_xml')
    def start(name, attrs):
        nonlocal depth, nodes
        depth += 1; nodes += 1
        if depth > 64 or nodes > 50000: reject()
        builder.start(name, attrs)
    def end(name):
        nonlocal depth
        builder.end(name); depth -= 1
    def doctype(name, system, public, internal):
        if internal: reject()
    parser.StartElementHandler = start
    parser.EndElementHandler = end
    parser.CharacterDataHandler = builder.data
    parser.StartDoctypeDeclHandler = doctype
    parser.EntityDeclHandler = reject
    parser.UnparsedEntityDeclHandler = reject
    parser.ExternalEntityRefHandler = reject
    parser.SetParamEntityParsing(expat.XML_PARAM_ENTITY_PARSING_NEVER)
    try:
        parser.Parse(body, True)
        root = builder.close()
        if root.tag != 'PubmedArticleSet': reject()
        return root
    except (expat.ExpatError, ValueError):
        raise ValueError('invalid_pubmed_xml') from None


def parse_pubmed_xml(body: bytes, sources: tuple[Source, ...], *, limits: Limits):
    eligible = tuple(s for s in sources[:limits.evidence_records] if canonical_pmid(s.url))
    excluded = [CaptureExclusion(citation_id=s.id, reason='non_pubmed_source') for s in sources if not canonical_pmid(s.url)]
    try:
        root = _parse(body, limits.snapshot_bytes)
    except ValueError:
        return tuple(_unavailable(s) for s in eligible), tuple(excluded + [
            CaptureExclusion(citation_id=s.id, reason='invalid_pubmed_xml') for s in eligible])
    articles, duplicates = {}, set()
    for article in root.findall('./PubmedArticle'):
        pmid = article.findtext('./MedlineCitation/PMID', '')
        if pmid in articles: duplicates.add(pmid)
        articles[pmid] = article
    evidence = []
    for source in eligible:
        pmid = canonical_pmid(source.url)
        if pmid not in articles or pmid in duplicates:
            evidence.append(_unavailable(source))
            excluded.append(CaptureExclusion(citation_id=source.id, reason='ambiguous_pmid' if pmid in duplicates else 'missing_article'))
            continue
        collector = EvidenceCollector()
        collector(source.model_dump(), articles[pmid])
        record = Evidence.model_validate_json(canonical_json({**collector.records[source.id], 'evidence_id':_evidence_id(source)}))
        evidence.append(record)
        excluded.extend(CaptureExclusion.model_validate(e) for e in collector.exclusions)
    return tuple(evidence), tuple(excluded)


async def fetch_pubmed_evidence(sources: tuple[Source, ...], *, client: httpx.AsyncClient,
                               limits: Limits, before_request: Callable[[], str | None]):
    ids = list(dict.fromkeys(canonical_pmid(s.url) for s in sources[:limits.evidence_records] if canonical_pmid(s.url)))
    if not ids:
        return (), tuple(CaptureExclusion(citation_id=s.id, reason='non_pubmed_source') for s in sources)
    if before_request(): raise ValueError('review_authority_changed')
    try:
        async with client.stream('GET', EFETCH, params={'db':'pubmed','retmode':'xml','id':','.join(ids)},
                                 headers={'Accept-Encoding':'identity'}, follow_redirects=False, timeout=10) as response:
            if response.status_code != 200 or response.headers.get('content-encoding','identity').lower() != 'identity':
                raise ValueError('pubmed_unavailable')
            body = bytearray()
            async for chunk in response.aiter_bytes(chunk_size=16384):
                if len(body)+len(chunk)>limits.snapshot_bytes: raise ValueError('pubmed_unavailable')
                body.extend(chunk)
        return parse_pubmed_xml(bytes(body), sources, limits=limits)
    except (httpx.RequestError, ValueError):
        eligible = tuple(s for s in sources[:limits.evidence_records] if canonical_pmid(s.url))
        return tuple(_unavailable(s) for s in eligible), tuple(CaptureExclusion(citation_id=s.id,
            reason='pubmed_unavailable' if canonical_pmid(s.url) else 'non_pubmed_source') for s in sources)

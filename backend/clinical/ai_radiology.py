"""Native adaptations of the OpenMed metadata and report-structuring workflows.

Deterministic, source-anchored extraction only: no NER weights, diagnoses, coding,
deidentification claims, filesystem access or external service calls.
"""
from __future__ import annotations
import hashlib
import re
from pydantic import Field
from .ai_exploration_contracts import Record, Handle


class MetadataRequest(Record):
    series_id: Handle


class StructureReportRequest(Record):
    text: str = Field(min_length=1, max_length=12000)


HEADINGS = re.compile(r'(?im)^[ \t]*(indication|clinical history|history|technique|comparison|findings|impression|conclusion)[ \t]*:[ \t]*')
SECTIONS = {'clinical history': 'indication', 'history': 'indication', 'conclusion': 'impression'}
MEASUREMENT = re.compile(r'(?<![\w.+-])[-+]?(?:\d+(?:\.\d+)?|\.\d+)(?:\s*[x×]\s*(?:\d+(?:\.\d+)?|\.\d+)){0,2}\s*(?:mm|cm|mL|HU)\b', re.I)


def structure_report(text: str) -> dict:
    """Retain exact Unicode character offsets and literal wording, including qualifiers."""
    headings = list(HEADINGS.finditer(text))
    sections = []
    if not headings or text[:headings[0].start()].strip():
        end = headings[0].start() if headings else len(text)
        sections.append({'section': 'unsectioned', 'start': 0, 'end': end, 'text': text[:end]})
    for index, heading in enumerate(headings):
        start = heading.end()
        end = headings[index+1].start() if index+1 < len(headings) else len(text)
        name = heading.group(1).lower()
        sections.append({'section': SECTIONS.get(name, name), 'start': start, 'end': end, 'text': text[start:end]})
    measurements = []
    for match in MEASUREMENT.finditer(text):
        measurements.append({'text': match.group(), 'start': match.start(), 'end': match.end(),
            'section': next((s['section'] for s in sections if s['start'] <= match.start() < s['end']), 'unsectioned')})
    return {'schemaVersion': 'radsysx-radiology-report-v1', 'sourceSha256': hashlib.sha256(text.encode()).hexdigest(),
        'offsetUnit': 'unicode_code_points', 'sections': sections, 'measurements': measurements,
        'missingSections': [name for name in ('indication', 'technique', 'comparison', 'findings', 'impression') if not any(s['section'] == name for s in sections)],
        'limitations': ['Literal extraction only. Qualifiers, negation, laterality and recommendations remain in their original text; no clinical labels or follow-up advice are inferred.',
            'Offsets refer to this exact supplied text. A structured draft is not a validated or saved report.']}


def series_metadata(pages: list[dict]) -> dict:
    """Expose only validated technical fields from the scoped OHIF inventory."""
    first = pages[0]
    frames = [frame for page in pages for frame in page['frames']]
    geometries = []
    for frame in frames:
        item = {key: frame[key] for key in ('rows', 'columns', 'spacing', 'orientation') if key in frame}
        if item not in geometries: geometries.append(item)
        if len(geometries) == 8: break
    return {'schemaVersion': 'radsysx-series-metadata-v1', 'source': 'validated_shared_viewer_inventory',
        'seriesId': first['seriesId'], 'modality': first['modality'], 'frameCount': first['frameCount'],
        'geometrySamples': geometries, 'spacingUnit': 'mm', 'ordering': first['ordering'],
        'limitations': ['Technical metadata only; no image findings. Geometry samples may vary across frames.',
            'Patient fields, original DICOM UIDs, private tags and free-text headers are excluded. This is not a full-header PHI audit or a deidentification certificate.',
            'DICOM SR content is not present in this viewer inventory. Supply an explicitly deidentified report to structure its text.']}

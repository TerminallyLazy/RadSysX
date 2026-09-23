"""Source fidelity and identifier exclusion for the native OpenMed adaptations."""
from backend.clinical.ai_radiology import structure_report, series_metadata


def test_report_preserves_negation_uncertainty_units_and_unicode_offsets():
    source = 'Findings: No left pleural effusion. Possible right nodule, 1.2 × 0.8 cm.\nImpression: Indeterminate; compare with prior imaging.'
    result = structure_report(source)
    assert [s['section'] for s in result['sections']] == ['findings', 'impression']
    for span in [*result['sections'], *result['measurements']]:
        assert source[span['start']:span['end']] == span['text']
    assert result['measurements'][0]['text'] == '1.2 × 0.8 cm'
    assert result['missingSections'] == ['indication', 'technique', 'comparison']
    assert structure_report('No acute findings.')['sections'][0]['section'] == 'unsectioned'


def test_metadata_uses_technical_allowlist_not_patient_fields_or_uids():
    import json
    result = series_metadata([{'seriesId': 'series-1', 'modality': 'CT', 'frameCount': 1, 'ordering': 'display_set',
        'PatientName': 'PRIVATE', 'SeriesInstanceUID': 'PRIVATE',
        'frames': [{'rows': 512, 'columns': 512, 'spacing': [0.7, 1.2], 'PatientID': 'PRIVATE', 'SOPInstanceUID': 'PRIVATE'}]}])
    assert 'PRIVATE' not in json.dumps(result)
    assert result['geometrySamples'] == [{'rows': 512, 'columns': 512, 'spacing': [0.7, 1.2]}]
    assert result['spacingUnit'] == 'mm'

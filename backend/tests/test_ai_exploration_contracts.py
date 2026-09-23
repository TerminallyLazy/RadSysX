"""Untrusted viewer metadata and transient images have a strict private wire boundary."""
import base64
import hashlib
from io import BytesIO
import pytest
from PIL import Image
from backend.clinical.ai_exploration_contracts import FrameDescriptor, SeriesManifest, ShareSelection, ImageObservation, ObservationResult


def synthetic_manifest(count=34):
    return {'manifestId':'manifest-1','studyId':'study-1','seriesId':'series-1','modality':'CT',
            'frameCount':count,'ordering':'display_set','frames':[{'id':f'frame-{i}','index':i,'rows':64,'columns':64,'spacing':[0.7,1.2]} for i in range(count)]}


@pytest.mark.parametrize('change', [{'index':True}, {'index':-1}, {'id':'file:///private'}, {'id':'1.2.840.123'}, {'rows':0}, {'position':[float('nan'),0,0]}, {'spacing':[0,1]}, {'url':'https://example.org'}])
def test_invalid_frame_metadata_is_rejected(change):
    with pytest.raises(ValueError): FrameDescriptor.model_validate({**synthetic_manifest(1)['frames'][0], **change})


def test_manifest_digest_changes_with_order_and_count():
    one = SeriesManifest.model_validate(synthetic_manifest(2))
    swapped = synthetic_manifest(2)
    swapped['frames'][0]['id'], swapped['frames'][1]['id'] = 'frame-1', 'frame-0'
    assert one.digest() != SeriesManifest.model_validate(swapped).digest()
    assert one.digest() != SeriesManifest.model_validate(synthetic_manifest(1)).digest()
    bad = synthetic_manifest(2); bad['frames'][1]['index'] = 0
    with pytest.raises(ValueError): SeriesManifest.model_validate(bad)


@pytest.mark.parametrize('change', [{'actor':'admin'}, {'seriesIds':[]}, {'seriesIds':['series-1']*33}, {'studyId':'other/path'}, {'allowViewerTools':'true'}, {'studyIds':['study-1','study-2']}])
def test_scope_cannot_smuggle_identity_or_mixed_studies(change):
    with pytest.raises(ValueError): ShareSelection.model_validate({'kind':'series','studyId':'study-1','seriesIds':['series-1'],'allowViewerTools':False,**change})


def observation():
    buffer=BytesIO(); Image.new('RGB',(16,16),'navy').save(buffer,format='JPEG')
    raw=buffer.getvalue()
    return {'imageId':'image-1','kind':'frame','frameId':'frame-0','manifestId':'manifest-1','index':0,
            'width':16,'height':16,'originalWidth':16,'originalHeight':16,'capturedAt':'2026-09-23T00:00:00Z',
            'sha256':hashlib.sha256(raw).hexdigest(),'data':base64.b64encode(raw).decode(),'presentation':{}}


def test_receipt_drops_pixels_and_decode_checks_exact_dimensions_hash():
    value = observation(); image = ImageObservation.model_validate(value)
    assert 'data' not in image.receipt() and value['data'] not in repr(image)
    for changed in ({'width':17},{'sha256':'0'*64},{'data':'not base64'},{'width':2049},{'presentation':{'windowWidth':float('inf')}}):
        with pytest.raises(ValueError): ImageObservation.model_validate({**value,**changed})
    result = {'operationId':'op-1','claimId':'claim-1','revision':1,'images':[value]*9,'failures':[]}
    with pytest.raises(ValueError): ObservationResult.model_validate(result)


def test_observation_rejects_duplicate_images_and_truncated_jpeg():
    value = observation()
    raw = base64.b64decode(value['data'])
    broken = raw[:180] + b'\xff\xd9'
    with pytest.raises(ValueError):
        ImageObservation.model_validate({**value,'data':base64.b64encode(broken).decode(),'sha256':hashlib.sha256(broken).hexdigest()})
    with pytest.raises(ValueError):
        ObservationResult.model_validate({'operationId':'op-1','claimId':'claim-1','revision':1,'images':[value,value],'failures':[]})

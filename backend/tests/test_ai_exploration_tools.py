import pytest
from backend.clinical.ai_tools import validate_tool, declarations

@pytest.mark.parametrize('name,args',[
 ('viewer_select_viewport',{'viewportId':'viewport-1'}),
 ('viewer_set_orientation',{'orientation':'axial'}),
 ('viewer_set_overlays',{'visible':False,'referenceLines':True}),
 ('viewer_set_sync',{'enabled':True,'type':'imageSlice','viewportIds':['viewport-1','viewport-2']}),
 ('viewer_open_panel',{'panel':'measurements'}),
 ('viewer_set_cine',{'playing':True,'fps':24}),
 ('viewer_set_mpr',{'layout':'mpr'}),
 ('viewer_set_crosshair',{'worldPoint':[0.0,10.0,20.0]}),
 ('viewer_set_fusion',{'displaySetId':'series-2','opacity':0.4,'preset':'Hot Iron'}),
 ('viewer_set_volume',{'blend':'maximum','slabThickness':10.0}),
])
def test_explicit_reading_schemas_accept_typed_controls(name,args):
    assert validate_tool(name,args)

@pytest.mark.parametrize('name,args',[
 ('runCommand',{'name':'anything'}),('viewer_open_panel',{'panel':'credentials'}),
 ('viewer_set_cine',{'playing':True,'fps':float('inf')}),('viewer_set_cine',{'playing':True,'fps':0}),
 ('viewer_set_crosshair',{'worldPoint':[float('nan'),0,0]}),('viewer_set_crosshair',{'worldPoint':[0,0]}),
 ('viewer_set_fusion',{'displaySetId':'series-2','opacity':1.1}),
 ('viewer_set_orientation',{'orientation':'axial','command':'private'}),
 ('viewer_set_view',{'zoom':float('nan')}),('viewer_set_sync',{'enabled':True,'type':'url','viewportIds':['viewport-1']}),
])
def test_reading_schemas_reject_unbounded_or_arbitrary_commands(name,args):
    with pytest.raises(ValueError):validate_tool(name,args)

def test_enabled_advanced_render_controls_have_explicit_bounded_contracts():
    assert validate_tool('viewer_set_rendering',{'displaySetId':'series-1','threshold':100.0,'colorbar':True})
    assert validate_tool('viewer_set_volume',{'quality':0.5,'ambient':0.2,'diffuse':0.4,'specular':0.3,'shade':True})
    with pytest.raises(ValueError):validate_tool('viewer_set_volume',{'quality':float('nan')})

def test_volume_opacity_shift_is_bounded():
    assert validate_tool('viewer_set_volume', {'opacityShift': 10.0})
    with pytest.raises(ValueError):validate_tool('viewer_set_volume', {'opacityShift': 1000001.0})

@pytest.mark.parametrize('tool,count', [('Length',2),('ArrowAnnotate',2),('Angle',3),('CobbAngle',4),('Bidirectional',4),('Probe',1),('RectangleROI',2),('EllipticalROI',4),('CircleROI',2),('PlanarFreehandROI',3),('SplineROI',3),('LivewireContour',3),('UltrasoundDirectional',2)])
def test_calibrated_geometry_contracts(tool,count):
    points=([[0.1,0.2],[0.5,0.8]] if tool=='RectangleROI' else [[0.1,0.2],[0.5,0.2],[0.5,0.8],[0.1,0.8]][:count])
    assert validate_tool('viewer_measurement',{'operation':'create','type':tool,'points':points})
    with pytest.raises(ValueError):validate_tool('viewer_measurement',{'operation':'create','type':tool,'points':points+[points[0]]})

@pytest.mark.parametrize('points', [[[0.2,0.3]]*2,[[float('nan'),0.1],[0.2,0.8]],[[0.1,0.2],[2.0,0.8]]])
def test_degenerate_geometry_never_enters_native_tools(points):
    with pytest.raises(ValueError):validate_tool('viewer_measurement',{'operation':'create','type':'Length','points':points})

def test_measurement_geometry_edits_and_capture_identity():
    args={'operation':'update','measurementId':'measurement-1','type':'Angle','points':[[0.1,0.2],[0.4,0.6],[0.7,0.2]], 'coordinateSpace':'canvas','frameId':'frame-1','revision':4}
    assert validate_tool('viewer_measurement',args)
    with pytest.raises(ValueError):validate_tool('viewer_measurement',{**args,'coordinateSpace':'javascript'})

def test_segmentation_edits_remain_typed_and_calibration_requires_review():
    from backend.clinical.ai_tools import requires_approval
    assert validate_tool('viewer_segmentation',{'operation':'segment_visibility','segmentationId':'segmentation-1','segmentIndex':1,'visible':False})
    assert validate_tool('viewer_calibrate',{'points':[[0.1,0.1],[0.8,0.8]],'knownLengthMm':10.0})
    assert requires_approval('viewer_calibrate',{})
    assert requires_approval('viewer_measurement',{'operation':'delete'})

def test_native_region_tools_are_explicit_not_arbitrary_pointer_actions():
    assert validate_tool('viewer_region',{'tool':'WindowLevelRegion','points':[[0.1,0.2],[0.6,0.8]]})
    assert validate_tool('viewer_region',{'tool':'AdvancedMagnify','points':[[0.5,0.5]],'zoom':3.0})
    with pytest.raises(ValueError):validate_tool('viewer_region',{'tool':'evaluate','points':[[0.5,0.5]]})

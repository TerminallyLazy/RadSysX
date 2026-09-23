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

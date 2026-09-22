"""Generation provenance is the actual dispatch, never today's preference or prompt text."""
import asyncio
from backend.tests.test_ai_live import live, runtime_for


def test_unrecorded_generation_is_unknown(live):
    runtime = runtime_for(live)
    assert live.service.repository.research_generation(runtime.id,'old-tool') == {'providerId':None,'modelId':None,'recordedAt':None}


def test_dispatch_provenance_survives_preferences_without_changing_result(live, monkeypatch):
    async def scenario():
        runtime=runtime_for(live)
        runtime.config.research_provider='nvidia_nim'; runtime.config.research_model='z-ai/glm-5.3-flash'; runtime.config.nvidia_api_key='synthetic-nim'
        result={'summary':'Synthetic finding [s1].','sources':[{'id':'s1','title':'Fixture','url':'https://pubmed.ncbi.nlm.nih.gov/123/'}],'limitations':[]}
        class Supervisor:
            def __init__(self,*,provider,model,api_key):
                assert (provider,model,api_key)==('nvidia_nim','z-ai/glm-5.3-flash','synthetic-nim')
            async def run(self,query): return result
        monkeypatch.setattr('backend.clinical.ai_research.ResearchSupervisor',Supervisor)
        tool,_=live.service.repository.add_tool(runtime.id,'research','research_run',{'query':'fixture'},1,False)
        await runtime.execute(tool)
        live.service.repository.save_research_preference(live.actor.sub,'gemini','gemini-3.8-flash')
        record=live.service.repository.research_generation(runtime.id,'research')
        assert record['providerId']=='nvidia_nim' and record['modelId']=='z-ai/glm-5.3-flash' and record['recordedAt']
        assert live.service.repository.tool(runtime.id,'research')['result']==result
        assert live.provider.responses[-1].response=={'status':'completed','result':result}
        await live.service.stop(runtime.id)
        live.service.repository.clear(runtime.id,live.actor)
        assert live.service.repository.research_generation(runtime.id,'research')['modelId'] is None
    asyncio.run(scenario())

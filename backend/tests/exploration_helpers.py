"""Synthetic renderer requests through the actual owned task service."""
import asyncio
from backend.tests.test_ai_codex import configured
from backend.tests.test_ai_text import session_request
from backend.tests.test_ai_exploration_contracts import synthetic_manifest
from backend.clinical.ai_exploration_contracts import ShareSelection, RendererBinding, SeriesManifest

async def make_task(live, *, allow_tools=True, frames=34, active=True):
    codex=configured(live)
    client=await codex.client(live.actor); client.signed_in=True
    await codex.status(live.actor)
    await live.service.change_research_settings(live.actor,'codex','synthetic-codex-model')
    request=session_request()
    request.viewer_context.state.update({'studyId':'study-1','series':[{'id':'series-1','studyId':'study-1','imageCount':frames}]})
    row=await live.service.text.create(request,live.actor)
    binding=RendererBinding(rendererId='renderer-1',epoch='epoch-1',contextVersion=row['contextVersion'],revision=0,studyId='study-1',seriesIds=['series-1'])
    selection=ShareSelection(kind='series',studyId='study-1',seriesIds=['series-1'],allowViewerTools=allow_tools)
    service=live.service.exploration
    grant=await service.prepare(row['sessionId'],selection,binding,live.actor)
    commands=await service.poll(grant.task_id,binding,live.actor,wait_seconds=1)
    for command in commands:
        claimed=await service.claim(grant.task_id,command.operation_id,binding,live.actor)
        await service.complete_manifest(grant.task_id,claimed.operation_id,claimed.claim_id,binding,SeriesManifest.model_validate(synthetic_manifest(frames)),live.actor)
    await service.tasks[grant.task_id].inventory_task
    if active:
        live.service.repository.add_tool(row['sessionId'],'run-1','text_chat',{'query':'Synthetic'},row['contextVersion'],False)
        await service.activate(grant.task_id,'run-1',live.actor)
    return service,grant,binding

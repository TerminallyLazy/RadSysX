"""Owned research dropdown settings, synthetic catalog and isolated persistence."""
import asyncio
from unittest.mock import AsyncMock

import pytest
from fastapi.testclient import TestClient

from backend.tests.test_ai_live import live, authorize, ORIGIN, runtime_for

ROOT='/api/ai/sidebar/research-settings'
MODEL='z-ai/glm-5.3-flash'


@pytest.fixture
def catalog(live,monkeypatch):
    live.service.config.nvidia_api_key='synthetic-nvidia'
    mock=AsyncMock(return_value={'provider':'nvidia_nim','models':[MODEL,'openai/gpt-oss-20b'],'capabilities_verified':False})
    monkeypatch.setattr('backend.evidence_review.nim.discover_models',mock)
    return mock


def test_saved_selection_is_owned_persistent_and_used_by_runtime(live,catalog):
    from backend.clinical.ai_live import AILiveService
    other=live.manager.issue_for_username('attending-radiologist')
    with TestClient(live.app) as client:
        authorize(client,live)
        status=client.get(ROOT)
        assert status.status_code==200 and status.headers['cache-control']=='no-store'
        assert status.json()['providerId']=='gemini'
        models=client.get(ROOT+'/models/nvidia_nim')
        assert models.json()['models']==[MODEL,'openai/gpt-oss-20b']
        response=client.put(ROOT,json={'providerId':'nvidia_nim','modelId':MODEL},headers={'origin':ORIGIN})
        assert response.status_code==200 and response.json()['source']=='saved'
        assert live.service.config_for(live.actor).research_configuration()==('nvidia_nim','synthetic-nvidia',MODEL)
        assert live.service.config_for(other).research_provider=='gemini'
        restored=AILiveService(live.service.clinical,live.repository,live.service.platform)
        assert restored.config_for(live.actor).research_model==MODEL
        assert 'synthetic-nvidia' not in response.text+models.text+status.text


def test_model_change_stops_only_owners_sessions(live,catalog):
    async def scenario():
        own=runtime_for(live)
        other=runtime_for(live,actor=live.manager.issue_for_username('attending-radiologist'))
        try:
            await live.service.change_research_settings(live.actor,'nvidia_nim',MODEL)
            assert own.closed and not other.closed
            assert live.service.config_for(live.actor).research_model==MODEL
        finally: await live.service.shutdown()
    asyncio.run(scenario())


@pytest.mark.parametrize('payload',[{'providerId':'nvidia_nim','modelId':'invented/model'},
    {'providerId':'openai','modelId':MODEL},{'providerId':'nvidia_nim','modelId':'https://secret:pass@evil.test'},
    {'providerId':'nvidia_nim','modelId':MODEL,'owner':'other'},{'providerId':'gemini','modelId':MODEL}])
def test_unlisted_invalid_or_cross_provider_models_are_rejected(live,catalog,payload):
    with TestClient(live.app) as client:
        authorize(client,live)
        response=client.put(ROOT,json=payload,headers={'origin':ORIGIN})
        assert response.status_code==422
        assert 'secret:pass' not in response.text
        assert live.service.config_for(live.actor).research_provider=='gemini'


def test_auth_origin_mode_and_catalog_failure(live,catalog):
    with TestClient(live.app) as client:
        assert client.get(ROOT).status_code==401
        authorize(client,live)
        assert client.put(ROOT,json={'providerId':'nvidia_nim','modelId':MODEL}).status_code==403
        catalog.return_value={'error':'credential_rejected'}
        response=client.get(ROOT+'/models/nvidia_nim')
        assert response.status_code==503 and response.headers['cache-control']=='no-store'
        assert client.get(ROOT).json()['providerId']=='gemini'
        live.service.config.app_mode='clinical'
        before=catalog.await_count
        assert client.get(ROOT+'/models/nvidia_nim').status_code==403
        assert catalog.await_count==before

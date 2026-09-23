import pytest
from fastapi.testclient import TestClient
from backend.tests.test_ai_live import live, authorize, PREFIX, ORIGIN
from backend.tests.exploration_helpers import make_task


def test_history_reads_never_reissue_commands_and_writes_require_origin(live):
    with TestClient(live.app) as client:
        service,task,binding=client.portal.call(make_task,live)
        authorize(client,live)
        url=f'{PREFIX}/sessions/{task.session_id}/explorations/{task.task_id}'
        response=client.get(url)
        assert response.status_code==200 and response.headers['cache-control']=='no-store'
        assert 'claimId' not in response.text and 'commands' not in response.json()
        assert client.post(url+'/poll',json={'binding':binding.wire()}).status_code==403
        bad=client.post(url+'/poll',json={'binding':binding.wire(),'actor':'PRIVATE'},headers={'origin':ORIGIN})
        assert bad.status_code==422 and 'PRIVATE' not in bad.text
        assert client.post(url+'/stop',json={},headers={'origin':ORIGIN}).status_code==200
        assert client.post(url+'/poll',json={'binding':binding.wire()},headers={'origin':ORIGIN}).status_code==409


def test_other_owner_and_clinical_mode_cannot_access_task(live):
    with TestClient(live.app) as client:
        service,task,binding=client.portal.call(make_task,live)
        authorize(client,live,live.manager.issue_for_username('attending-radiologist'))
        url=f'{PREFIX}/sessions/{task.session_id}/explorations/{task.task_id}'
        assert client.get(url).status_code==404
        authorize(client,live)
        live.service.config.app_mode='clinical'
        assert client.get(url).status_code==403


def test_decisions_and_empty_writes_are_strict_bounded_and_private(live):
    with TestClient(live.app) as client:
        service,task,binding=client.portal.call(make_task,live)
        authorize(client,live)
        url=f'{PREFIX}/sessions/{task.session_id}/explorations/{task.task_id}'
        response=client.post(url+'/decisions/op-1',json={'contextVersion':binding.context_version,'approved':True,'private':'DO_NOT_ECHO'},headers={'origin':ORIGIN})
        assert response.status_code==422
        assert 'DO_NOT_ECHO' not in response.text
        response=client.post(url+'/poll',content=b' '*65537,headers={'origin':ORIGIN,'content-type':'application/json'})
        assert response.status_code==422
        response=client.post(url+'/stop',json={'private':'DO_NOT_ECHO'},headers={'origin':ORIGIN})
        assert response.status_code==422 and 'DO_NOT_ECHO' not in response.text

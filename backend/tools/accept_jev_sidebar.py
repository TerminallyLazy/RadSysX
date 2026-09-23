"""Opt-in one-claim TypeSafe acceptance through the normal owned sidebar API.

The source is deliberately synthetic. No user database, voice or real NCBI
retrieval is involved; the TypeSafe request always uses the normal transport.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
from pathlib import Path
import secrets
import stat
import tempfile
from unittest.mock import patch

CLAIM='The synthetic study reports 10 samples [s1].'
ABSTRACT='The synthetic study reports 10 samples.'
ORIGIN='http://jev-acceptance.test'


def read_key(env_file):
    key=os.environ.get('RADSYSX_TYPESAFE_AI_API_KEY','')
    if not key and env_file:
        from dotenv import dotenv_values
        key=dotenv_values(env_file,interpolate=False).get('RADSYSX_TYPESAFE_AI_API_KEY') or ''
    if not key: raise ValueError('TypeSafe credential is unavailable.')
    return key


async def run_acceptance(key, workspace):
    import httpx
    from fastapi import FastAPI
    from backend.clinical import ai_evidence_review
    from backend.clinical.ai_live import AILiveService
    from backend.clinical.ai_routes import live_router
    from backend.clinical.auth import ClinicalSessionManager
    from backend.clinical.config import ClinicalPlatformSettings
    from backend.clinical.contracts import AISidebarSessionCreateRequest
    from backend.clinical.repositories import ClinicalRepository
    from backend.clinical.services import ClinicalPlatformService

    # Compose a synthetic host with explicit environment, suppressing the normal
    # implicit .env.ai load. Only the caller-resolved TypeSafe key enters it.
    environment={'RADSYSX_APP_MODE':'pilot','RADSYSX_AI_ENABLED':'true',
        'RADSYSX_TYPESAFE_AI_API_KEY':key,'RADSYSX_AI_EVIDENCE_DIR':str(workspace/'evidence'),
        'RADSYSX_CLINICAL_API_SECRET':secrets.token_urlsafe(32),'RADSYSX_SESSION_SECRET':secrets.token_urlsafe(32),
        'RADSYSX_SESSION_COOKIE_SECURE':'false','RADSYSX_ALLOWED_ORIGINS':ORIGIN}
    with patch.dict(os.environ,environment,clear=True), patch('dotenv.dotenv_values',return_value={}):
        settings=ClinicalPlatformSettings()
        repository=ClinicalRepository(f'sqlite:///{workspace / "acceptance.db"}')
        repository.initialize()
        service=AILiveService(ClinicalPlatformService(settings,repository,None),repository,settings)
    manager=ClinicalSessionManager(settings); actor=manager.issue_for_username('demo-radiologist')
    app=FastAPI();app.include_router(live_router(service,manager))
    session=service.create(AISidebarSessionCreateRequest(),actor)
    sid=session['sessionId'];tid='synthetic-acceptance'
    source={'summary':CLAIM,'sources':[{'id':'s1','title':'Synthetic acceptance fixture, not a real PubMed paper','url':'https://pubmed.ncbi.nlm.nih.gov/123/'}],'limitations':['Synthetic source; not a real PubMed retrieval.']}
    service.repository.add_tool(sid,tid,'research_run',{},1,False)
    service.repository.set_tool(sid,tid,'completed',source)
    original_factory=ai_evidence_review.new_http_client

    class SyntheticSourceTransport(httpx.AsyncBaseTransport):
        def __init__(self): self.remote=original_factory()
        async def handle_async_request(self,request):
            if request.url.host=='eutils.ncbi.nlm.nih.gov':
                xml=f'<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>123</PMID><Article><Abstract><AbstractText>{ABSTRACT}</AbstractText></Abstract></Article></MedlineCitation></PubmedArticle></PubmedArticleSet>'
                return httpx.Response(200,content=xml.encode())
            if request.url.host!='api.typesafe.ai': raise ValueError('Unexpected acceptance destination.')
            return await self.remote.send(request,stream=True)
        async def aclose(self): await self.remote.aclose()

    try:
        with patch.object(ai_evidence_review,'new_http_client',lambda:httpx.AsyncClient(transport=SyntheticSourceTransport(),trust_env=False)):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url=ORIGIN) as client:
                client.cookies.set(manager.cookie_name,manager.dumps(actor))
                async def request(path,body=None):
                    reply=await client.request('GET' if body is None else 'POST','/api/ai/sidebar'+path,
                        json=body,headers={'Origin':ORIGIN})
                    if reply.status_code!=200: raise ValueError('Acceptance API request failed.')
                    return reply.json()
                detail=await request(f'/sessions/{sid}/tools/{tid}/evidence-reviews',{'idempotencyKey':'acceptance-prepare'})
                rid=detail['reviewId']
                await service.evidence_reviews.jobs[rid].task
                detail=await request(f'/evidence-reviews/{rid}')
                if detail['status']!='ready': raise ValueError('Synthetic source preparation failed.')
                await request(f'/evidence-reviews/{rid}/start',{'idempotencyKey':'acceptance-start','previewSha256':detail['previewSha256'],
                    'selectedUnitIds':[c['unitId'] for c in detail['claims'] if c['eligible']],'confirmation':'synthetic'})
                if rid in service.evidence_reviews.jobs: await service.evidence_reviews.jobs[rid].task
                detail=await request(f'/evidence-reviews/{rid}')
                unchanged=service.repository.tool(sid,tid)['result']==source and detail['originalAnswer']==CLAIM
                assessment=detail['assessments'][0] if detail['assessments'] else {}
                return {'source':'live TypeSafe with synthetic source','status':detail['status'],'unchangedAnswer':unchanged,
                    'reviewId':rid,'requestedModel':'jev-1.13.0','resolvedModel':assessment.get('resolvedModel'),
                    'label':assessment.get('label'),'answerSha256':detail['answerSha256'],'snapshotSha256':detail['snapshotSha256'],
                    'abstractSha256':detail['abstracts'][0]['textSha256'],'requestSha256':assessment.get('requestSha256'),
                    'rubricVersion':assessment.get('rubricVersion'),'rubricSha256':assessment.get('rubricSha256'),
                    'attempts':detail['attempts'],'reason':detail['reason']}
    finally:
        await service.shutdown();repository._engine.dispose()


def main(argv=None, *, output_root=None):
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--allow-live',action='store_true')
    parser.add_argument('--env-file',type=Path)
    args=parser.parse_args(argv)
    if not args.allow_live:
        print('Refused: --allow-live is required before reading credentials or making requests.')
        return 2
    previous_mask=os.umask(0o077)
    try:
        key=read_key(args.env_file)
        output_root=Path(output_root or Path(__file__).resolve().parents[2]/'tmp'/'jev-sidebar-acceptance')
        output_root.mkdir(parents=True,exist_ok=True,mode=0o700)
        info=output_root.lstat()
        if not stat.S_ISDIR(info.st_mode) or info.st_uid!=os.getuid() or stat.S_IMODE(info.st_mode)!=0o700:
            raise ValueError('Private acceptance output is unavailable.')
        run_dir=Path(tempfile.mkdtemp(prefix='run-',dir=output_root))
        with tempfile.TemporaryDirectory(prefix='workspace-',dir=run_dir) as temp:
            report=asyncio.run(run_acceptance(key,Path(temp)))
        key=''
        receipt=run_dir/'receipt.json'
        with receipt.open('x') as handle: json.dump(report,handle,ensure_ascii=False,indent=2)
        print(json.dumps({'source':report['source'],'status':report['status'],'resolvedModel':report['resolvedModel'],'receipt':str(receipt)}))
        return 0 if report['status']=='completed' and report['unchangedAnswer'] and report['resolvedModel']=='jev-1.13.0' else 1
    except Exception:
        print('Acceptance did not complete. Check the TypeSafe credential, service availability and private output storage.')
        return 1
    finally: os.umask(previous_mask)


if __name__=='__main__': raise SystemExit(main())

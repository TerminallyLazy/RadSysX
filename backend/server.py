#!/usr/bin/env python
"""FastAPI entrypoint for RadSysX."""

from fastapi import FastAPI, File, Form, HTTPException, Query, Request, Response, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel
import asyncio
import inspect
import json
import logging
import os
import pathlib
import traceback
from typing import List, Dict, Any, Optional
from uuid import uuid4

RADSYSX_IMPORT_ERROR = None

try:
    from backend.radsysx import process_query, stream_query, enable_disable_mcp  # type: ignore
except Exception as exc:
    RADSYSX_IMPORT_ERROR = exc

    def process_query(query: str):  # type: ignore
        return f"RadSysX agent stack is unavailable: {exc}"

    async def stream_query(query: str):  # type: ignore
        yield f"RadSysX agent stack is unavailable: {exc}"

    def enable_disable_mcp(enabled: bool):  # type: ignore
        return f"MCP toggle unavailable because RadSysX failed to import: {exc}"

MCP_IMPORT_ERROR = None

try:
    from backend.mcp.fhir_server import FHIRMCPServer  # type: ignore
    from backend.mcp.client import RadSysXMCPClient  # type: ignore
except Exception:
    try:
        from mcp.fhir_server import FHIRMCPServer
        from mcp.client import RadSysXMCPClient
    except Exception as exc:
        MCP_IMPORT_ERROR = exc
        FHIRMCPServer = None  # type: ignore[assignment]
        RadSysXMCPClient = None  # type: ignore[assignment]

CHAT_IMPORT_ERROR = None

try:
    from backend.chat_interface import initialize_chat_interface, get_chat_interface  # type: ignore
except Exception:
    try:
        from chat_interface import initialize_chat_interface, get_chat_interface  # type: ignore
    except Exception as exc:
        CHAT_IMPORT_ERROR = exc

        class _FallbackChatInterface:
            async def chat(self, **_: Any) -> str:
                return f"Chat interface is unavailable: {exc}"

            async def stream_chat(self, **_: Any):
                yield f"Chat interface is unavailable: {exc}"

            def get_available_tools(self):
                return []

        def initialize_chat_interface():  # type: ignore
            return _FallbackChatInterface()

        def get_chat_interface():  # type: ignore
            return _FallbackChatInterface()

try:
    from backend.clinical.auth import ClinicalSessionManager
    from backend.clinical.config import get_settings
    from backend.clinical.contracts import (
        AIJobCreateRequest,
        AISidebarCapabilities,
        AISidebarMessageRequest,
        AISidebarSessionCreateRequest,
        AISidebarSessionResponse,
        AISidebarTurnResponse,
        AuditAction,
        AuthMode,
        ClinicalPlatformConfig,
        DerivedResultStowRequest,
        DerivedResultRequest,
        ImagingLaunchRequest,
        LocalImagingImportResponse,
        LocalImagingStudyAnalysisResponse,
        LocalImagingStudyAssetsResponse,
        LocalLoginRequest,
        ReportDraftRequest,
        ResourceType,
        SessionClaims,
        SessionResponse,
    )
    from backend.clinical.dicomweb import (
        OrthancDICOMwebAdapter,
        UploadedDicomPart,
        normalize_dicom_stow_content_type,
    )
    from backend.clinical.local_imaging import LocalImagingImporter, LocalImagingUploadPart
    from backend.clinical.repositories import ClinicalRepository
    from backend.clinical.services import ClinicalPlatformService
    from backend.biomedparse_demo import (
        BiomedParseDemoCapabilities,
        BiomedParseDemoRunRequest,
        BiomedParseDemoRunResponse,
        biomedparse_demo_artifact_path,
        biomedparse_demo_capabilities,
        run_biomedparse_demo,
    )
except ModuleNotFoundError:
    from clinical.auth import ClinicalSessionManager
    from clinical.config import get_settings
    from clinical.contracts import (
        AIJobCreateRequest,
        AISidebarCapabilities,
        AISidebarMessageRequest,
        AISidebarSessionCreateRequest,
        AISidebarSessionResponse,
        AISidebarTurnResponse,
        AuditAction,
        AuthMode,
        ClinicalPlatformConfig,
        DerivedResultStowRequest,
        DerivedResultRequest,
        ImagingLaunchRequest,
        LocalImagingImportResponse,
        LocalImagingStudyAnalysisResponse,
        LocalImagingStudyAssetsResponse,
        LocalLoginRequest,
        ReportDraftRequest,
        ResourceType,
        SessionClaims,
        SessionResponse,
    )
    from clinical.dicomweb import (
        OrthancDICOMwebAdapter,
        UploadedDicomPart,
        normalize_dicom_stow_content_type,
    )
    from clinical.local_imaging import LocalImagingImporter, LocalImagingUploadPart
    from clinical.repositories import ClinicalRepository
    from clinical.services import ClinicalPlatformService
    from biomedparse_demo import (
        BiomedParseDemoCapabilities,
        BiomedParseDemoRunRequest,
        BiomedParseDemoRunResponse,
        biomedparse_demo_artifact_path,
        biomedparse_demo_capabilities,
        run_biomedparse_demo,
    )

settings = get_settings()
session_manager = ClinicalSessionManager(settings)

app = FastAPI(title="RadSysX API")


class _FallbackFHIRServer:
    available = False

    def __init__(self, reason: Exception | str) -> None:
        self.unavailable_reason = str(reason)

    async def initialize(self):
        return None

    async def list_resources(self, uri_pattern: str = "", mime_type: str | None = None):
        return {"error": f"FHIR integration unavailable: {self.unavailable_reason}"}

    async def call_tool(self, tool_name: str, params: dict[str, Any]):
        return {
            "error": f"FHIR integration unavailable: {self.unavailable_reason}",
            "tool": tool_name,
            "params": params,
        }

    async def get_patient_demographics(self, patient_id: str):
        return await self.call_tool("get_patient_demographics", {"patient_id": patient_id})

    async def get_medication_list(self, patient_id: str):
        return await self.call_tool("get_medication_list", {"patient_id": patient_id})

    async def search_resources(self, resource_type: str, search_params: dict):
        return await self.call_tool(
            "search_fhir_resources",
            {"resource_type": resource_type, "params": search_params},
        )


async def _initialize_fhir_server(server: Any) -> Any:
    initialize = getattr(server, "initialize", None)
    if initialize is None:
        return None
    if inspect.iscoroutinefunction(initialize):
        return await initialize()
    return await asyncio.to_thread(initialize)


async def _execute_fhir_tool_request(tool_name: str, params: dict[str, Any]) -> Any:
    if tool_name == "list_fhir_resources":
        return await fhir_server.list_resources("", None)
    if tool_name in {"get_patient_demographics", "get_medication_list", "search_fhir_resources"}:
        return await fhir_server.call_tool(tool_name, params)
    raise ValueError(f"Unknown FHIR tool: {tool_name}")

# Define the path to frontend files
frontend_dir = pathlib.Path(__file__).parent.parent / "frontend"

# Mount static files serving
app.mount("/static", StaticFiles(directory=str(frontend_dir)), name="frontend")

# ✅ Enable CORS (Allow frontend to call API)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"] if settings.allow_wildcard_cors else settings.allowed_origins,
    allow_credentials=not settings.allow_wildcard_cors,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Define request models
class QueryRequest(BaseModel):
    query: str

class FHIRToolRequest(BaseModel):
    tool: str
    params: dict

class ChatRequest(BaseModel):
    message: str
    model_provider: Optional[str] = "openai"  # 'openai' or 'google'
    model_name: Optional[str] = None

class ToolRequest(BaseModel):
    tool_name: str
    params: Dict[str, Any] = {}

class MCPServerInstallRequest(BaseModel):
    server_name: str
    args: Optional[List[str]] = None
    env: Optional[List[str]] = None

# ✅ Expose the query-processing endpoint
@app.post("/process")
async def process(request: QueryRequest):
    """API endpoint to process user queries and return only human-readable content."""
    try:
        result = await asyncio.to_thread(process_query, request.query)
        return {"result": result}
    except Exception as e:
        import traceback
        print(f"Error processing query: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Error processing query: {str(e)}"}


# MCP Status Endpoint
@app.get("/mcp/status")
async def get_mcp_status():
    """Get the current status of MCP integration."""
    try:
        # Call the function to get current MCP enabled status
        # This assumes you've implemented a way to check if MCP is enabled
        result = {"enabled": True}  # Replace with actual status check
        return result
    except Exception as e:
        return {"error": f"Error getting MCP status: {str(e)}"}


# MCP Toggle Endpoint
@app.post("/mcp/toggle")
async def toggle_mcp(request: dict = {"enabled": True}):
    """Toggle MCP integration on or off."""
    try:
        enabled = request.get("enabled", True)
        result = await asyncio.to_thread(enable_disable_mcp, enabled)
        return {"status": result, "enabled": enabled}
    except Exception as e:
        return {"error": f"Error toggling MCP: {str(e)}"}


# New streaming endpoint
@app.post("/stream")
@app.get("/stream")  # Add support for GET requests for EventSource
async def stream(request: Request):
    """API endpoint to stream user query responses as they become available."""
    # Handle both GET and POST requests
    if request.method == "GET":
        # Extract query from URL parameters
        query_params = dict(request.query_params)
        user_query = query_params.get("query", "")
        # Get MCP status from query params (default to True if not provided)
        mcp_enabled_str = query_params.get("mcp_enabled", "true").lower()
        mcp_enabled = mcp_enabled_str != "false"  # Anything except "false" will enable MCP
    else:
        # For POST requests, extract from JSON body
        try:
            body = await request.json()
            user_query = body.get("query", "")
            mcp_enabled = body.get("mcp_enabled", True)
        except:
            user_query = ""
            mcp_enabled = True
    
    if not user_query:
        return {"error": "No query provided"}
    
    # Set MCP integration status before processing the query
    try:
        await asyncio.to_thread(enable_disable_mcp, mcp_enabled)
        print(f"MCP integration set to: {mcp_enabled} for query: {user_query[:50]}...")
    except Exception as e:
        print(f"Error setting MCP status: {str(e)}")
    
    async def event_generator():
        try:
            # Use a generator function from the RadSysX agent stack with MCP support
            last_tool_used = None
            async for chunk in stream_query(user_query):
                if not chunk:
                    continue
                    
                # If this is a tool usage notification from the backend
                if isinstance(chunk, dict) and "tool_use" in chunk:
                    # Send tool usage information as a special event
                    tool_info = chunk["tool_use"]
                    tool_name = tool_info.get("name", "unknown_tool")
                    
                    if tool_name != last_tool_used:  # Only notify about new tools
                        last_tool_used = tool_name
                        tool_data = {"tool_use": {"tool_name": tool_name}}
                        yield f"data: {json.dumps(tool_data)}\n\n"
                else:
                    # Regular text chunks
                    response_data = {"chunk": chunk} if isinstance(chunk, str) else chunk
                    yield f"data: {json.dumps(response_data)}\n\n"
        except Exception as e:
            error_msg = str(e)
            tb = traceback.format_exc()
            print(f"Error in streaming: {error_msg}")
            print(tb)
            # Send the error to the client
            yield f"data: {json.dumps({'error': f'Sorry, an error occurred while processing your query: {error_msg}. Please try again later.'})}\n\n"
            yield "data: [DONE]\n\n"
    
    # Return a streaming response
    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
        }
    )

# Create FHIR server instance for handling tool requests
try:
    if FHIRMCPServer is None:
        raise RuntimeError(MCP_IMPORT_ERROR or "FHIR/MCP imports are unavailable.")
    fhir_server = FHIRMCPServer()
except Exception as exc:
    fhir_server = _FallbackFHIRServer(exc)
clinical_repository = ClinicalRepository(settings.clinical_database_url)
clinical_service = ClinicalPlatformService(
    settings=settings,
    repository=clinical_repository,
    dicomweb_adapter=OrthancDICOMwebAdapter(settings),
)
local_imaging_importer = LocalImagingImporter(settings, clinical_repository)
clinical_repository.initialize()

# Initialize FHIR server on startup
@app.on_event("startup")
async def startup_event():
    """Initialize services on startup."""
    if RADSYSX_IMPORT_ERROR is not None:
        print(f"Research agent stack unavailable: {RADSYSX_IMPORT_ERROR}")

    if getattr(fhir_server, "available", True):
        await _initialize_fhir_server(fhir_server)
        print("✅ FHIR server initialized and MCP integration enabled")
    else:
        print(
            "FHIR/MCP integration unavailable: "
            f"{getattr(fhir_server, 'unavailable_reason', 'unknown reason')}"
        )

    if CHAT_IMPORT_ERROR is None:
        initialize_chat_interface()
        print("✅ Chat interface initialized")
    else:
        print(f"Chat interface unavailable: {CHAT_IMPORT_ERROR}")


def _client_ip(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def _set_session_cookie(response: Response, session: SessionClaims) -> None:
    response.set_cookie(
        key=session_manager.cookie_name,
        value=session_manager.dumps(session),
        httponly=settings.session_cookie_httponly,
        samesite=settings.session_cookie_samesite,
        secure=settings.session_cookie_secure,
        max_age=settings.session_ttl_seconds,
        path=settings.session_cookie_path,
        domain=settings.session_cookie_domain,
    )


def _clear_session_cookie(response: Response) -> None:
    response.delete_cookie(
        key=session_manager.cookie_name,
        httponly=settings.session_cookie_httponly,
        samesite=settings.session_cookie_samesite,
        secure=settings.session_cookie_secure,
        path=settings.session_cookie_path,
        domain=settings.session_cookie_domain,
    )


def _optional_session(request: Request) -> SessionClaims | None:
    return session_manager.loads(request.cookies.get(session_manager.cookie_name))


def _require_session(request: Request) -> SessionClaims:
    session = _optional_session(request)
    if session is None:
        raise HTTPException(status_code=401, detail="Clinical session required.")
    return session


def _require_local_dicomweb() -> None:
    if not settings.local_imaging_enabled:
        raise HTTPException(status_code=404, detail="Local DICOMweb is not enabled for this runtime.")


def _parse_frame_numbers(value: str) -> list[int]:
    try:
        frame_numbers = [int(part) for part in value.split(",") if part.strip()]
    except ValueError as exc:
        raise HTTPException(status_code=400, detail="Frame numbers must be integers.") from exc
    if not frame_numbers or any(frame_number < 1 for frame_number in frame_numbers):
        raise HTTPException(status_code=400, detail="Frame numbers are one-based integers.")
    return frame_numbers


def _multipart_related_response(parts: list[bytes], content_type: str) -> Response:
    boundary = f"radsysx-local-{uuid4().hex}"
    body = bytearray()
    for part in parts:
        body.extend(f"--{boundary}\r\n".encode("ascii"))
        body.extend(f"Content-Type: {content_type}\r\n\r\n".encode("ascii"))
        body.extend(part)
        body.extend(b"\r\n")
    body.extend(f"--{boundary}--\r\n".encode("ascii"))
    return Response(
        content=bytes(body),
        media_type=f'multipart/related; type="{content_type}"; boundary={boundary}',
    )


@app.post("/api/auth/local-login")
async def clinical_local_login(payload: LocalLoginRequest, response: Response):
    """Issue a local clinical session for a seeded persona."""
    if settings.auth_mode != AuthMode.LOCAL:
        raise HTTPException(status_code=404, detail="Local clinical login is disabled for this deployment.")
    try:
        session = session_manager.issue_for_username(payload.username)
    except ValueError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _set_session_cookie(response, session)
    return {"session": session.model_dump(by_alias=True)}


@app.get("/api/auth/session")
async def clinical_auth_session(http_request: Request) -> SessionResponse:
    """Return the active clinical session if one exists."""
    session = _optional_session(http_request)
    return SessionResponse(authenticated=session is not None, session=session)


@app.post("/api/auth/logout")
async def clinical_auth_logout(response: Response) -> SessionResponse:
    """Clear the current clinical session cookie."""
    _clear_session_cookie(response)
    return SessionResponse(authenticated=False, session=None)


@app.get("/api/platform/config")
async def clinical_platform_config() -> ClinicalPlatformConfig:
    """Expose the active clinical platform posture to the frontend shell."""
    return ClinicalPlatformConfig(
        mode=settings.app_mode,
        experimental_routes_enabled=settings.experimental_routes_enabled,
        viewer_base_url=settings.viewer_base_url,
        viewer_kind=settings.viewer_kind,
        viewer_base_path=settings.viewer_base_path,
        auth_mode=settings.auth_mode,
        ai_default_workflow_mode=settings.ai_default_workflow_mode,
        ai_allow_active=settings.ai_allow_active,
        local_imaging_enabled=settings.local_imaging_enabled,
    )


@app.post("/api/imaging/launch")
async def launch_imaging(request: ImagingLaunchRequest, http_request: Request):
    """Create a signed imaging launch context for the viewer surface."""
    actor = _require_session(http_request)
    return await clinical_service.launch_imaging(
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.get("/api/imaging/launch/resolve")
async def resolve_imaging_launch(launch: str, http_request: Request):
    """Resolve an opaque launch token into the signed imaging context."""
    actor = _require_session(http_request)
    return await clinical_service.resolve_imaging_launch(
        launch,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.get("/api/worklist")
async def get_worklist(http_request: Request, trace_id: str | None = None):
    """Return the current radiology worklist."""
    actor = _require_session(http_request)
    return clinical_service.get_worklist(
        actor=actor,
        source_ip=_client_ip(http_request),
        trace_id=trace_id,
    )


@app.post("/api/local-imaging/import")
async def import_local_imaging(
    http_request: Request,
    relative_paths: str = Form(default="[]", alias="relativePaths"),
    files: list[UploadFile] = File(...),
) -> LocalImagingImportResponse:
    """Import local medical image files into the local workspace store."""
    if not settings.local_imaging_enabled:
        raise HTTPException(status_code=403, detail="Local imaging import is disabled for this runtime.")
    actor = _require_session(http_request)
    if not files:
        raise HTTPException(status_code=400, detail="At least one file is required.")
    if len(files) > settings.local_imaging_max_files:
        raise HTTPException(
            status_code=413,
            detail=f"Too many files for local import. Limit is {settings.local_imaging_max_files}.",
        )

    try:
        decoded_relative_paths = json.loads(relative_paths) if relative_paths else []
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid relativePaths JSON: {exc.msg}") from exc
    if not isinstance(decoded_relative_paths, list):
        raise HTTPException(status_code=400, detail="relativePaths must be a JSON array.")

    upload_parts: list[LocalImagingUploadPart] = []
    try:
        for index, upload in enumerate(files):
            data = await upload.read(settings.local_imaging_max_file_bytes + 1)
            if len(data) > settings.local_imaging_max_file_bytes:
                raise HTTPException(
                    status_code=413,
                    detail="One or more files exceed the local import size limit.",
                )
            upload_parts.append(
                LocalImagingUploadPart(
                    filename=upload.filename or f"upload-{index + 1}",
                    content_type=upload.content_type,
                    relative_path=(
                        str(decoded_relative_paths[index])
                        if index < len(decoded_relative_paths)
                        and decoded_relative_paths[index] is not None
                        else upload.filename
                    ),
                    data=data,
                )
            )

        result = local_imaging_importer.import_uploads(upload_parts)
    finally:
        for upload in files:
            await upload.close()

    for imported in result.imported_studies:
        clinical_repository.add_audit_event(
            clinical_service._build_audit_event(
                actor_user_id=actor.username,
                actor_role=actor.primary_role,
                action=AuditAction.IMPORT_STUDY,
                patient_ref="Patient/local-import",
                study_instance_uid=imported.study_instance_uid,
                resource_type=ResourceType.STUDY,
                resource_id=imported.study_instance_uid,
                source_ip=_client_ip(http_request),
            )
        )
    return result


@app.get("/api/local-imaging/studies/{study_uid}/assets")
async def get_local_imaging_study_assets(
    study_uid: str,
    http_request: Request,
) -> LocalImagingStudyAssetsResponse:
    """Return safe local asset metadata and deterministic analysis hints for an imported study."""
    if not settings.local_imaging_enabled:
        raise HTTPException(status_code=403, detail="Local imaging import is disabled for this runtime.")
    _require_session(http_request)
    return local_imaging_importer.study_assets(study_uid)


@app.get("/api/local-imaging/studies/{study_uid}/analysis")
async def get_local_imaging_study_analysis(
    study_uid: str,
    http_request: Request,
) -> LocalImagingStudyAnalysisResponse:
    """Return deterministic backend-side technical analysis for an imported local study."""
    if not settings.local_imaging_enabled:
        raise HTTPException(status_code=403, detail="Local imaging import is disabled for this runtime.")
    _require_session(http_request)
    return local_imaging_importer.study_analysis(study_uid)


@app.get("/api/local-imaging/studies/{study_uid}/assets/{asset_id}/preview")
async def get_local_imaging_asset_preview(
    study_uid: str,
    asset_id: str,
    http_request: Request,
    axis: str = "axial",
    slice_index: int | None = Query(default=None, alias="slice"),
) -> Response:
    """Return a backend-mediated local asset preview without exposing private storage paths."""
    if not settings.local_imaging_enabled:
        raise HTTPException(status_code=403, detail="Local imaging import is disabled for this runtime.")
    _require_session(http_request)
    preview = local_imaging_importer.preview_asset(
        study_uid,
        asset_id,
        axis=axis,
        slice_index=slice_index,
    )
    return Response(
        content=preview.content,
        media_type=preview.media_type,
        headers={"Cache-Control": "no-store"},
    )


@app.get("/dicom-web/studies")
async def local_dicomweb_search_studies(StudyInstanceUID: str | None = None):
    """Return DICOM JSON study metadata for local desktop imports."""
    _require_local_dicomweb()
    instances = local_imaging_importer.list_dicom_instances(study_instance_uid=StudyInstanceUID)
    seen: set[str] = set()
    studies: list[dict[str, Any]] = []
    for instance in instances:
        if instance.study_instance_uid in seen:
            continue
        seen.add(instance.study_instance_uid)
        metadata = local_imaging_importer.dicom_json_metadata(
            study_instance_uid=instance.study_instance_uid,
            series_instance_uid=instance.series_instance_uid,
            sop_instance_uid=instance.sop_instance_uid,
        )
        if metadata:
            studies.append(metadata[0])
    return studies


@app.get("/dicom-web/studies/{study_uid}/metadata")
async def local_dicomweb_study_metadata(study_uid: str):
    """Return local DICOM instance metadata for a study."""
    _require_local_dicomweb()
    return local_imaging_importer.dicom_json_metadata(study_instance_uid=study_uid)


@app.get("/dicom-web/studies/{study_uid}/series")
async def local_dicomweb_search_series(study_uid: str):
    """Return DICOM JSON series metadata for a local study."""
    _require_local_dicomweb()
    instances = local_imaging_importer.list_dicom_instances(study_instance_uid=study_uid)
    seen: set[str] = set()
    series: list[dict[str, Any]] = []
    for instance in instances:
        if instance.series_instance_uid in seen:
            continue
        seen.add(instance.series_instance_uid)
        metadata = local_imaging_importer.dicom_json_metadata(
            study_instance_uid=study_uid,
            series_instance_uid=instance.series_instance_uid,
            sop_instance_uid=instance.sop_instance_uid,
        )
        if metadata:
            series.append(metadata[0])
    return series


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/metadata")
async def local_dicomweb_series_metadata(study_uid: str, series_uid: str):
    """Return local DICOM instance metadata for a series."""
    _require_local_dicomweb()
    return local_imaging_importer.dicom_json_metadata(
        study_instance_uid=study_uid,
        series_instance_uid=series_uid,
    )


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances")
async def local_dicomweb_search_instances(study_uid: str, series_uid: str):
    """Return DICOM JSON instance metadata for a local series."""
    _require_local_dicomweb()
    return local_imaging_importer.dicom_json_metadata(
        study_instance_uid=study_uid,
        series_instance_uid=series_uid,
    )


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/metadata")
async def local_dicomweb_instance_metadata(study_uid: str, series_uid: str, sop_uid: str):
    """Return DICOM JSON metadata for a local instance."""
    _require_local_dicomweb()
    return local_imaging_importer.dicom_json_metadata(
        study_instance_uid=study_uid,
        series_instance_uid=series_uid,
        sop_instance_uid=sop_uid,
    )


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}")
async def local_dicomweb_instance(study_uid: str, series_uid: str, sop_uid: str):
    """Return a local DICOM instance as multipart WADO-RS content."""
    _require_local_dicomweb()
    payload = local_imaging_importer.read_dicom_instance(study_uid, series_uid, sop_uid)
    return _multipart_related_response([payload], "application/dicom")


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/bulkdata/{tag}")
async def local_dicomweb_bulkdata(study_uid: str, series_uid: str, sop_uid: str, tag: str):
    """Return local binary bulk data for a DICOM element."""
    _require_local_dicomweb()
    payload = local_imaging_importer.read_bulk_data(study_uid, series_uid, sop_uid, tag)
    return _multipart_related_response([payload], "application/octet-stream")


@app.get("/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/frames/{frames}")
async def local_dicomweb_frames(study_uid: str, series_uid: str, sop_uid: str, frames: str):
    """Return local uncompressed frame bytes for a DICOM instance."""
    _require_local_dicomweb()
    frame_numbers = _parse_frame_numbers(frames)
    payloads = [
        local_imaging_importer.read_frame(study_uid, series_uid, sop_uid, frame_number)
        for frame_number in frame_numbers
    ]
    return _multipart_related_response(payloads, "application/octet-stream")


@app.get("/api/studies/{study_uid}/workspace")
async def get_study_workspace(
    study_uid: str,
    http_request: Request,
    trace_id: str | None = None,
):
    """Return the workspace aggregate for a study."""
    actor = _require_session(http_request)
    return clinical_service.get_study_workspace(
        study_uid=study_uid,
        actor=actor,
        source_ip=_client_ip(http_request),
        trace_id=trace_id,
    )


@app.post("/api/reports/draft")
async def save_report(request: ReportDraftRequest, http_request: Request):
    """Create or update a report draft with provenance references."""
    actor = _require_session(http_request)
    return clinical_service.save_report(
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.post("/api/ai/jobs")
async def submit_ai_job(request: AIJobCreateRequest, http_request: Request):
    """Queue an AI job under governance rules."""
    actor = _require_session(http_request)
    return clinical_service.submit_ai_job(
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.get("/api/ai/sidebar/capabilities", response_model=AISidebarCapabilities)
async def get_ai_sidebar_capabilities(http_request: Request):
    """Return the backend-bound voice-first sidebar contract."""
    _require_session(http_request)
    return clinical_service.get_ai_sidebar_capabilities()


@app.post("/api/ai/sidebar/sessions", response_model=AISidebarSessionResponse)
async def create_ai_sidebar_session(request: AISidebarSessionCreateRequest, http_request: Request):
    """Create an ephemeral backend session for the OHIF AI sidebar."""
    actor = _require_session(http_request)
    return clinical_service.create_ai_sidebar_session(
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.post("/api/ai/sidebar/sessions/{session_id}/messages", response_model=AISidebarTurnResponse)
async def submit_ai_sidebar_message(
    session_id: str,
    request: AISidebarMessageRequest,
    http_request: Request,
):
    """Submit a voice or composer turn from the OHIF AI sidebar."""
    actor = _require_session(http_request)
    return clinical_service.submit_ai_sidebar_message(
        session_id,
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.get("/api/ai/biomedparse-demo/capabilities", response_model=BiomedParseDemoCapabilities)
async def get_biomedparse_demo_capabilities(http_request: Request):
    """Return the optional research BioMedParse demo state without loading model code."""
    _require_session(http_request)
    return biomedparse_demo_capabilities()


@app.post("/api/ai/biomedparse-demo/run", response_model=BiomedParseDemoRunResponse)
async def run_biomedparse_integration_demo(
    request: BiomedParseDemoRunRequest,
    http_request: Request,
):
    """Run the opt-in BioMedParse v2 demo as an isolated worker process."""
    _require_session(http_request)
    return await run_biomedparse_demo(request)


@app.get("/api/ai/biomedparse-demo/runs/{run_id}/mask.npz")
async def get_biomedparse_demo_mask(run_id: str, http_request: Request):
    """Return the mask NPZ for a completed BioMedParse demo run."""
    _require_session(http_request)
    return FileResponse(
        biomedparse_demo_artifact_path(run_id, "mask.npz"),
        media_type="application/octet-stream",
        filename=f"{run_id}-mask.npz",
        headers={"Cache-Control": "no-store"},
    )


@app.get("/api/ai/biomedparse-demo/runs/{run_id}/preview.png")
async def get_biomedparse_demo_preview(run_id: str, http_request: Request):
    """Return the preview PNG for a completed BioMedParse demo run."""
    _require_session(http_request)
    return FileResponse(
        biomedparse_demo_artifact_path(run_id, "preview.png"),
        media_type="image/png",
        filename=f"{run_id}-preview.png",
        headers={"Cache-Control": "no-store"},
    )


@app.post("/api/derived-results")
async def store_derived_results(request: DerivedResultRequest, http_request: Request):
    """Stage non-binary derived DICOM result references through the imaging gateway contract."""
    actor = _require_session(http_request)
    return await clinical_service.store_derived_results(
        request,
        actor=actor,
        source_ip=_client_ip(http_request),
    )


@app.post("/api/derived-results/stow")
async def store_derived_results_stow(
    http_request: Request,
    study_instance_uid: str = Form(alias="studyInstanceUID"),
    object_type: str = Form(alias="objectType"),
    storage_class: str = Form(alias="storageClass"),
    series_instance_uid: str | None = Form(default=None, alias="seriesInstanceUID"),
    sop_instance_uid: str | None = Form(default=None, alias="sopInstanceUID"),
    content_type: str = Form(default="application/dicom", alias="contentType"),
    metadata: str = Form(default="{}"),
    trace_id: str | None = Form(default=None, alias="traceId"),
    files: list[UploadFile] = File(...),
):
    """Store PS3.10 DICOM instances through the backend STOW gateway."""
    actor = _require_session(http_request)
    try:
        metadata_json = json.loads(metadata) if metadata else {}
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail=f"Invalid metadata JSON: {exc.msg}") from exc
    try:
        normalized_content_type = normalize_dicom_stow_content_type(content_type)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    payload = DerivedResultStowRequest(
        study_instance_uid=study_instance_uid,
        object_type=object_type,
        storage_class=storage_class,
        series_instance_uid=series_instance_uid,
        sop_instance_uid=sop_instance_uid,
        content_type=normalized_content_type,
        metadata=metadata_json,
        trace_id=trace_id,
    )
    file_payloads = [
        UploadedDicomPart(
            filename=upload.filename or "derived.dcm",
            stream=upload.file,
        )
        for upload in files
    ]
    try:
        return await clinical_service.store_uploaded_derived_results(
            payload,
            files=file_payloads,
            actor=actor,
            source_ip=_client_ip(http_request),
        )
    finally:
        for upload in files:
            await upload.close()


@app.get("/api/audit/studies/{study_uid}")
async def get_study_audit(study_uid: str, http_request: Request):
    """Return audit events tied to a study instance UID."""
    _require_session(http_request)
    return clinical_service.list_audit_events(study_uid)


# FHIR tool endpoint
@app.post("/fhir/tool")
async def fhir_tool(request: FHIRToolRequest):
    """API endpoint to call FHIR tools via MCP."""
    try:
        result = await _execute_fhir_tool_request(request.tool, request.params)
        return {"result": result}
    except ValueError as exc:
        return {"error": str(exc)}
    except Exception as e:
        import traceback
        print(f"Error executing FHIR tool: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Error executing FHIR tool: {str(e)}"}


# Chat endpoint - provides direct access to LLM
@app.post("/chat")
async def chat(request: ChatRequest):
    """API endpoint for direct chat with LLM."""
    try:
        interface = get_chat_interface()
        response = await interface.chat(
            message=request.message,
            model_provider=request.model_provider,
            model_name=request.model_name
        )
        return {"response": response}
    except Exception as e:
        import traceback
        print(f"Error in chat: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Error in chat: {str(e)}"}


# Chat streaming endpoint
@app.post("/chat/stream")
async def chat_stream(request: ChatRequest):
    """API endpoint to stream chat responses as they become available."""
    
    async def stream_generator():
        try:
            interface = get_chat_interface()
            async for chunk in interface.stream_chat(
                message=request.message,
                model_provider=request.model_provider,
                model_name=request.model_name
            ):
                if chunk:
                    yield f"data: {json.dumps({'chunk': chunk})}\n\n"
            
            # Signal that the stream is complete
            yield "data: [DONE]\n\n"
        except Exception as e:
            print(f"Error in streaming chat: {str(e)}")
            yield f"data: {json.dumps({'error': f'Error in streaming chat: {str(e)}'})}\n\n"
            yield "data: [DONE]\n\n"
    
    return StreamingResponse(
        stream_generator(),
        media_type="text/event-stream"
    )


# MCP Tool execution endpoint
@app.post("/execute_tool")
async def execute_tool(request: ToolRequest):
    """API endpoint to execute an MCP tool directly."""
    try:
        tool_name = request.tool_name
        params = request.params
        
        # Support FHIR tools
        if tool_name in ["list_fhir_resources", "get_patient_demographics", "get_medication_list", "search_fhir_resources"]:
            # Reuse the FHIR tool endpoint
            fhir_request = FHIRToolRequest(tool=tool_name, params=params)
            result = await fhir_tool(fhir_request)
            return result
        
        # Support for other MCP tools
        elif tool_name in ["search_web", "search_medical_literature"]:
            # Mock implementation for now
            result = f"Executed {tool_name} with parameters: {json.dumps(params)}"
            # In a real implementation, this would call the appropriate MCP server
            
            # Example of a real implementation for search_web:
            # result = await mcp_client.execute_tool("brave-search", "mcp1_brave_web_search", {
            #     "query": params.get("query", "")
            # })
            return result
        else:
            return f"Unknown tool: {tool_name}. Available tools can be found via the /tools endpoint."
    except Exception as e:
        import traceback
        print(f"Error executing tool {request.tool_name}: {str(e)}")
        print(traceback.format_exc())
        return f"Error executing tool: {str(e)}"


# List available tools
@app.get("/tools")
async def list_tools():
    """API endpoint to list all available MCP tools."""
    try:
        # Define FHIR-specific tools with rich metadata
        fhir_tools = [
            {
                "name": "list_fhir_resources",
                "description": "Lists all available FHIR resources that can be accessed",
                "type": "function",
                "category": "fhir"
            },
            {
                "name": "get_patient_demographics",
                "description": "Get demographics for a patient. Input should be a patient ID (e.g., 'example' for test data).",
                "type": "function",
                "category": "fhir"
            },
            {
                "name": "get_medication_list",
                "description": "Get medication list for a patient. Input should be a patient ID (e.g., 'example' for test data).",
                "type": "function",
                "category": "fhir"
            },
            {
                "name": "search_fhir_resources",
                "description": "Search FHIR resources. Requires resource_type (e.g., 'Patient', 'Medication') and params object.",
                "type": "function",
                "category": "fhir"
            }
        ]
        
        # Get the regular tools from the chat interface
        interface = get_chat_interface()
        regular_tools = interface.get_available_tools()
        
        # Combine all tools
        all_tools = fhir_tools + regular_tools if regular_tools else fhir_tools
        
        return all_tools
    except Exception as e:
        import traceback
        print(f"Error listing tools: {str(e)}")
        print(traceback.format_exc())
        return {"error": f"Error listing tools: {str(e)}"}


# MCP Server installation endpoint
@app.post("/mcp/install")
async def install_mcp_server(request: MCPServerInstallRequest):
    """API endpoint to install additional MCP servers."""
    try:
        server_name = request.server_name
        args = request.args or []
        env = request.env or []
        
        # This would call the MCP installer module
        # For now, just return a mock response
        return {"status": f"Installed MCP server {server_name} with args: {args} and env: {env}"}
    except Exception as e:
        return {"error": f"Error installing MCP server: {str(e)}"}


# Serve the chat UI
@app.get("/")
async def serve_chat_ui():
    """Serve the chat UI landing page."""
    index_html_path = frontend_dir / "index.html"
    try:
        with open(index_html_path, "r") as f:
            html_content = f.read()
            return HTMLResponse(content=html_content)
    except FileNotFoundError:
        return HTMLResponse(content="<h1>Frontend not found</h1><p>Make sure the frontend build is in the correct location.</p>")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)

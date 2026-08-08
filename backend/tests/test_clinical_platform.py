import asyncio
import base64
import gzip
import json
import os
import struct
import tempfile
import zipfile
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

import pytest
from fastapi.testclient import TestClient

TEST_DB_PATH = Path(tempfile.gettempdir()) / "radsysx-clinical-platform-test.db"
if TEST_DB_PATH.exists():
    TEST_DB_PATH.unlink()

os.environ["RADSYSX_CLINICAL_DATABASE_URL"] = f"sqlite:///{TEST_DB_PATH.as_posix()}"
os.environ.setdefault("RADSYSX_SESSION_COOKIE_SECURE", "false")

try:
    import backend.server as server_module  # type: ignore
    from backend.server import app, clinical_service  # type: ignore
    from backend.clinical.config import ClinicalPlatformSettings  # type: ignore
    from backend.clinical.contracts import AuthMode, StoreResult  # type: ignore
except Exception:
    import server as server_module  # type: ignore
    from server import app, clinical_service  # type: ignore
    from clinical.config import ClinicalPlatformSettings  # type: ignore
    from clinical.contracts import AuthMode, StoreResult  # type: ignore


client = TestClient(app)


def login(username: str = "demo-radiologist") -> None:
    response = client.post("/api/auth/local-login", json={"username": username})
    assert response.status_code == 200
    body = response.json()
    assert body["session"]["username"] == username
    assert "expiresAt" in body["session"]


def make_test_dicom_bytes(
    *,
    study_uid: str = "1.2.826.0.1.3680043.10.54321.1",
    series_uid: str = "1.2.826.0.1.3680043.10.54321.2",
    sop_uid: str = "1.2.826.0.1.3680043.10.54321.3",
) -> bytes:
    pydicom = pytest.importorskip("pydicom")
    from pydicom.dataset import FileDataset, FileMetaDataset
    from pydicom.uid import CTImageStorage, ExplicitVRLittleEndian, generate_uid

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = CTImageStorage
    file_meta.MediaStorageSOPInstanceUID = sop_uid or generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    dataset = FileDataset(None, {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = CTImageStorage
    dataset.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    dataset.StudyInstanceUID = study_uid
    dataset.SeriesInstanceUID = series_uid
    dataset.Modality = "CT"
    dataset.PatientID = "DO-NOT-LOG"
    dataset.Rows = 2
    dataset.Columns = 2
    dataset.SamplesPerPixel = 1
    dataset.PhotometricInterpretation = "MONOCHROME2"
    dataset.BitsAllocated = 8
    dataset.BitsStored = 8
    dataset.HighBit = 7
    dataset.PixelRepresentation = 0
    dataset.PixelData = bytes([0, 1, 2, 3])
    dataset.is_little_endian = True
    dataset.is_implicit_VR = False

    output = BytesIO()
    dataset.save_as(output, enforce_file_format=True)
    return output.getvalue()


def make_test_dicomdir_bytes(references: list[list[str] | str] | None = None) -> bytes:
    pytest.importorskip("pydicom")
    from pydicom.dataset import Dataset, FileDataset, FileMetaDataset
    from pydicom.sequence import Sequence
    from pydicom.uid import ExplicitVRLittleEndian, MediaStorageDirectoryStorage, generate_uid

    file_meta = FileMetaDataset()
    file_meta.MediaStorageSOPClassUID = MediaStorageDirectoryStorage
    file_meta.MediaStorageSOPInstanceUID = generate_uid()
    file_meta.TransferSyntaxUID = ExplicitVRLittleEndian

    dataset = FileDataset(None, {}, file_meta=file_meta, preamble=b"\0" * 128)
    dataset.SOPClassUID = MediaStorageDirectoryStorage
    dataset.SOPInstanceUID = file_meta.MediaStorageSOPInstanceUID
    dataset.is_little_endian = True
    dataset.is_implicit_VR = False

    directory_records = []
    for reference in references or [["CASEA", "SCAN1DCM"]]:
        image_record = Dataset()
        image_record.DirectoryRecordType = "IMAGE"
        image_record.ReferencedFileID = reference
        directory_records.append(image_record)
    dataset.DirectoryRecordSequence = Sequence(directory_records)

    output = BytesIO()
    dataset.save_as(output, enforce_file_format=True)
    return output.getvalue()


def make_test_nifti_bytes() -> bytes:
    header = bytearray(352)
    header[0:4] = (348).to_bytes(4, "little")
    header[40:56] = struct.pack("<8h", 3, 2, 3, 4, 1, 1, 1, 1)
    header[70:72] = (2).to_bytes(2, "little", signed=True)
    header[72:74] = (8).to_bytes(2, "little", signed=True)
    header[108:112] = struct.pack("<f", 352.0)
    header[344:348] = b"n+1\0"
    return bytes(header) + bytes(range(24))


def make_test_paired_nifti_bytes() -> tuple[bytes, bytes]:
    header = bytearray(352)
    header[0:4] = (348).to_bytes(4, "little")
    header[40:56] = struct.pack("<8h", 3, 2, 3, 4, 1, 1, 1, 1)
    header[70:72] = (2).to_bytes(2, "little", signed=True)
    header[72:74] = (8).to_bytes(2, "little", signed=True)
    header[108:112] = struct.pack("<f", 0.0)
    header[344:348] = b"ni1\0"
    return bytes(header), bytes(range(24))


def make_test_nrrd_bytes() -> bytes:
    header = (
        b"NRRD0005\n"
        b"# synthetic PHI-free local imaging test volume\n"
        b"type: uint8\n"
        b"dimension: 3\n"
        b"sizes: 2 3 4\n"
        b"encoding: raw\n"
        b"endian: little\n\n"
    )
    return header + bytes(range(24))


def make_test_png_bytes() -> bytes:
    return (
        b"\x89PNG\r\n\x1a\n"
        b"\x00\x00\x00\rIHDR"
        b"\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00"
        b"\x90wS\xde"
        b"\x00\x00\x00\x0cIDATx\x9cc\xf8\xff\xff?\x00\x05\xfe\x02\xfe"
        b"\xdc\xccY\xe7"
        b"\x00\x00\x00\x00IEND\xaeB`\x82"
    )


def make_test_jpeg_bytes() -> bytes:
    return base64.b64decode(
        "/9j/4AAQSkZJRgABAQAAAAAAAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUG"
        "CQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/wAALCAABAAEBAREA"
        "/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEA"
        "AD8AVN//2Q=="
    )


def make_test_tiff_bytes() -> bytes:
    entries = [
        struct.pack("<HHI", 256, 4, 1) + struct.pack("<I", 2),
        struct.pack("<HHI", 257, 4, 1) + struct.pack("<I", 3),
        struct.pack("<HHI", 258, 3, 1) + struct.pack("<H", 8) + b"\x00\x00",
    ]
    return (
        b"II"
        + struct.pack("<HI", 42, 8)
        + struct.pack("<H", len(entries))
        + b"".join(entries)
        + struct.pack("<I", 0)
    )


def make_test_zip_bytes(entries: list[tuple[str, bytes]]) -> bytes:
    output = BytesIO()
    with zipfile.ZipFile(output, mode="w", compression=zipfile.ZIP_DEFLATED) as archive:
        for relative_path, payload in entries:
            archive.writestr(relative_path, payload)
    return output.getvalue()


def test_auth_session_lifecycle() -> None:
    unauthenticated = client.get("/api/auth/session")
    assert unauthenticated.status_code == 200
    assert unauthenticated.json() == {"authenticated": False, "session": None}

    login()

    authenticated = client.get("/api/auth/session")
    assert authenticated.status_code == 200
    payload = authenticated.json()
    assert payload["authenticated"] is True
    assert payload["session"]["username"] == "demo-radiologist"
    assert payload["session"]["roles"] == ["radiologist"]

    logout = client.post("/api/auth/logout")
    assert logout.status_code == 200
    assert logout.json() == {"authenticated": False, "session": None}

    after_logout = client.get("/api/auth/session")
    assert after_logout.status_code == 200
    assert after_logout.json() == {"authenticated": False, "session": None}


def test_clinical_endpoints_require_session() -> None:
    response = client.get("/api/worklist")
    assert response.status_code == 401
    assert "session required" in response.json()["detail"].lower()


def test_platform_config_exposes_auth_and_viewer_shape() -> None:
    response = client.get("/api/platform/config")
    assert response.status_code == 200

    payload = response.json()
    assert payload["mode"] in {"research", "pilot", "clinical"}
    assert payload["viewerKind"] == "ohif"
    assert payload["viewerBasePath"] == "/viewer"
    assert payload["authMode"] == "local"
    assert payload["aiDefaultWorkflowMode"] == "shadow"
    assert payload["aiAllowActive"] is False
    assert payload["localImagingEnabled"] is False


def test_research_mode_keeps_development_signing_secret_default(monkeypatch) -> None:
    monkeypatch.setenv("RADSYSX_APP_MODE", "research")
    monkeypatch.delenv("RADSYSX_CLINICAL_API_SECRET", raising=False)
    monkeypatch.delenv("RADSYSX_SESSION_SECRET", raising=False)
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SECURE", "false")

    settings = ClinicalPlatformSettings()

    assert settings.clinical_api_secret == "development-only-secret-change-me"
    assert settings.session_secret == settings.clinical_api_secret
    assert settings.session_cookie_secure is False
    assert settings.session_cookie_samesite == "lax"


def test_clinical_mode_requires_explicit_signing_secret(monkeypatch) -> None:
    monkeypatch.setenv("RADSYSX_APP_MODE", "clinical")
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SECURE", "true")
    monkeypatch.delenv("RADSYSX_CLINICAL_API_SECRET", raising=False)
    monkeypatch.delenv("RADSYSX_SESSION_SECRET", raising=False)

    with pytest.raises(RuntimeError, match="RADSYSX_CLINICAL_API_SECRET"):
        ClinicalPlatformSettings()


def test_clinical_mode_uses_explicit_signing_secret_for_sessions(monkeypatch) -> None:
    monkeypatch.setenv("RADSYSX_APP_MODE", "clinical")
    monkeypatch.setenv("RADSYSX_CLINICAL_API_SECRET", "pytest-clinical-signing-secret")
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SECURE", "true")
    monkeypatch.delenv("RADSYSX_SESSION_SECRET", raising=False)

    settings = ClinicalPlatformSettings()

    assert settings.clinical_api_secret == "pytest-clinical-signing-secret"
    assert settings.session_secret == "pytest-clinical-signing-secret"
    assert settings.session_cookie_secure is True


def test_cookie_settings_validate_none_requires_secure(monkeypatch) -> None:
    monkeypatch.setenv("RADSYSX_APP_MODE", "clinical")
    monkeypatch.setenv("RADSYSX_CLINICAL_API_SECRET", "pytest-clinical-signing-secret")
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SECURE", "false")
    monkeypatch.setenv("RADSYSX_SESSION_COOKIE_SAMESITE", "none")

    with pytest.raises(RuntimeError, match="RADSYSX_SESSION_COOKIE_SAMESITE"):
        ClinicalPlatformSettings()


def test_local_login_rejects_unknown_persona(monkeypatch) -> None:
    monkeypatch.setattr(server_module.settings, "auth_mode", AuthMode.LOCAL)

    response = client.post("/api/auth/local-login", json={"username": "missing-user"})

    assert response.status_code == 404
    assert "unknown local clinical user" in response.json()["detail"].lower()


def test_local_login_is_disabled_when_auth_mode_is_not_local(monkeypatch) -> None:
    monkeypatch.setattr(server_module.settings, "auth_mode", AuthMode.OIDC)

    response = client.post("/api/auth/local-login", json={"username": "demo-radiologist"})

    assert response.status_code == 404
    assert "disabled" in response.json()["detail"].lower()


def test_session_cookie_policy_is_applied_to_login_response(monkeypatch) -> None:
    monkeypatch.setattr(server_module.settings, "auth_mode", AuthMode.LOCAL)
    monkeypatch.setattr(server_module.settings, "session_cookie_secure", True)
    monkeypatch.setattr(server_module.settings, "session_cookie_samesite", "none")
    monkeypatch.setattr(server_module.settings, "session_cookie_path", "/")
    monkeypatch.setattr(server_module.settings, "session_cookie_domain", None)
    monkeypatch.setattr(server_module.settings, "session_cookie_httponly", True)

    response = client.post("/api/auth/local-login", json={"username": "demo-radiologist"})

    assert response.status_code == 200
    set_cookie = response.headers["set-cookie"].lower()
    assert "secure" in set_cookie
    assert "samesite=none" in set_cookie


def test_worklist_returns_seeded_rows_for_authenticated_actor() -> None:
    login()

    response = client.get("/api/worklist")
    assert response.status_code == 200

    payload = response.json()
    assert payload["role"] == "radiologist"
    assert payload["userId"] == "demo-radiologist"
    assert len(payload["rows"]) >= 1
    assert "studyInstanceUID" in payload["rows"][0]


def test_local_imaging_import_requires_explicit_runtime_enablement(monkeypatch) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", False)

    response = client.post(
        "/api/local-imaging/import",
        data={"relativePaths": "[]"},
        files=[("files", ("scan.dcm", make_test_dicom_bytes(), "application/dicom"))],
    )

    assert response.status_code == 403
    assert "disabled" in response.json()["detail"].lower()


def test_local_imaging_import_registers_dicom_and_nifti_worklist_row(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    study_uid = "1.2.826.0.1.3680043.10.54321.100"

    response = client.post(
        "/api/local-imaging/import",
        data={
            "relativePaths": json.dumps(
                ["case-a/scan-1.dcm", "case-a/volume.nii"],
            ),
        },
        files=[
            ("files", ("scan-1.dcm", make_test_dicom_bytes(study_uid=study_uid), "application/dicom")),
            ("files", ("volume.nii", make_test_nifti_bytes(), "application/octet-stream")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 2
    assert payload["rejectedFiles"] == 0
    assert len(payload["importedStudies"]) == 2
    dicom_import = next(
        study for study in payload["importedStudies"] if study["studyInstanceUID"] == study_uid
    )
    assert dicom_import["archiveRef"].startswith("local://")
    assert dicom_import["formats"] == ["dicom"]

    worklist = client.get("/api/worklist")
    assert worklist.status_code == 200
    rows = worklist.json()["rows"]
    assert any(row["studyInstanceUID"] == study_uid for row in rows)
    local_row = next(row for row in rows if row["studyInstanceUID"] == study_uid)
    assert local_row["patientRef"] == "Patient/local-import"
    assert local_row["archiveRef"].startswith("local://")

    manifests = list(tmp_path.glob("import-*/manifest.json"))
    assert len(manifests) == 1
    manifest_text = manifests[0].read_text(encoding="utf-8")
    assert "DO-NOT-LOG" not in manifest_text


def test_local_imaging_study_assets_describe_nifti_gz_nrrd_and_images(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))

    response = client.post(
        "/api/local-imaging/import",
        data={
            "relativePaths": json.dumps(
                [
                    "case-b/volume.nii.gz",
                    "case-b/segmentation.nrrd",
                    "case-b/slice.png",
                    "case-b/slice.jpeg",
                    "case-b/slice.tiff",
                ],
            ),
        },
        files=[
            ("files", ("volume.nii.gz", gzip.compress(make_test_nifti_bytes()), "application/gzip")),
            ("files", ("segmentation.nrrd", make_test_nrrd_bytes(), "application/octet-stream")),
            ("files", ("slice.png", make_test_png_bytes(), "image/png")),
            ("files", ("slice.jpeg", make_test_jpeg_bytes(), "image/jpeg")),
            ("files", ("slice.tiff", make_test_tiff_bytes(), "image/tiff")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 5
    imported = payload["importedStudies"][0]
    assert imported["formats"] == ["jpeg", "nifti", "nrrd", "png", "tiff"]

    assets_response = client.get(
        f"/api/local-imaging/studies/{imported['studyInstanceUID']}/assets",
    )
    assert assets_response.status_code == 200
    assets_payload = assets_response.json()
    assert assets_payload["studyInstanceUID"] == imported["studyInstanceUID"]
    assert assets_payload["archiveRef"].startswith("local://")
    assert assets_payload["formats"] == ["jpeg", "nifti", "nrrd", "png", "tiff"]
    assert assets_payload["fileCount"] == 5
    assert "backend-side analysis" in assets_payload["summary"]

    assets = assets_payload["assets"]
    assert {asset["format"] for asset in assets} == {"jpeg", "nifti", "nrrd", "png", "tiff"}
    nifti_asset = next(asset for asset in assets if asset["format"] == "nifti")
    assert nifti_asset["relativePath"] == "case-b/volume.nii.gz"
    assert nifti_asset["analysisSupported"] is True
    assert nifti_asset["viewerSupported"] is False
    assert nifti_asset["assetId"].startswith("import-")
    assert nifti_asset["previewSupported"] is True
    assert nifti_asset["previewUrl"].endswith(f"/assets/{nifti_asset['assetId']}/preview")
    assert nifti_asset["previewSlices"] == {"axial": 4, "coronal": 3, "sagittal": 2}
    assert nifti_asset["defaultPreviewAxis"] == "axial"
    assert nifti_asset["defaultPreviewSlice"] == 2

    png_asset = next(asset for asset in assets if asset["format"] == "png")
    assert png_asset["previewSupported"] is True
    assert png_asset["previewUrl"].endswith(f"/assets/{png_asset['assetId']}/preview")

    jpeg_asset = next(asset for asset in assets if asset["format"] == "jpeg")
    assert jpeg_asset["previewSupported"] is True
    assert jpeg_asset["previewUrl"].endswith(f"/assets/{jpeg_asset['assetId']}/preview")

    tiff_asset = next(asset for asset in assets if asset["format"] == "tiff")
    assert tiff_asset["previewSupported"] is True
    assert tiff_asset["previewUrl"].endswith(f"/assets/{tiff_asset['assetId']}/preview")

    nrrd_asset = next(asset for asset in assets if asset["format"] == "nrrd")
    assert nrrd_asset["relativePath"] == "case-b/segmentation.nrrd"
    assert nrrd_asset["analysisSupported"] is True
    assert nrrd_asset["viewerSupported"] is False
    assert nrrd_asset["previewSupported"] is False
    assert nrrd_asset["previewUrl"] is None

    findings = {finding["label"]: finding["value"] for finding in assets_payload["findings"]}
    assert findings["Files"] == "5"
    assert "2 x 3 x 4 voxels" in findings["NIFTI volume"]
    assert findings["NRRD volume"] == "2 x 3 x 4 voxels; type uint8; encoding raw"
    assert findings["Image files"] == "3"

    nifti_preview = client.get(nifti_asset["previewUrl"])
    assert nifti_preview.status_code == 200
    assert nifti_preview.headers["content-type"].startswith("image/svg+xml")
    assert nifti_preview.headers["cache-control"] == "no-store"
    assert b"<svg" in nifti_preview.content
    assert b"NIFTI axial slice 3 preview" in nifti_preview.content

    coronal_preview = client.get(f"{nifti_asset['previewUrl']}?axis=coronal&slice=1")
    assert coronal_preview.status_code == 200
    assert b"NIFTI coronal slice 2 preview" in coronal_preview.content

    sagittal_preview = client.get(f"{nifti_asset['previewUrl']}?axis=sagittal&slice=1")
    assert sagittal_preview.status_code == 200
    assert b"NIFTI sagittal slice 2 preview" in sagittal_preview.content

    bad_axis_preview = client.get(f"{nifti_asset['previewUrl']}?axis=diagonal&slice=0")
    assert bad_axis_preview.status_code == 400

    png_preview = client.get(png_asset["previewUrl"])
    assert png_preview.status_code == 200
    assert png_preview.headers["content-type"].startswith("image/png")
    assert png_preview.content.startswith(b"\x89PNG\r\n\x1a\n")

    jpeg_preview = client.get(jpeg_asset["previewUrl"])
    assert jpeg_preview.status_code == 200
    assert jpeg_preview.headers["content-type"].startswith("image/jpeg")
    assert jpeg_preview.content.startswith(b"\xff\xd8")

    tiff_preview = client.get(tiff_asset["previewUrl"])
    assert tiff_preview.status_code == 200
    assert tiff_preview.headers["content-type"].startswith("image/svg+xml")
    assert tiff_preview.headers["cache-control"] == "no-store"
    assert b"TIFF header preview 2 x 3" in tiff_preview.content

    analysis_response = client.get(
        f"/api/local-imaging/studies/{imported['studyInstanceUID']}/analysis",
    )
    assert analysis_response.status_code == 200
    analysis_payload = analysis_response.json()
    assert analysis_payload["studyInstanceUID"] == imported["studyInstanceUID"]
    assert "backend technical checks" in analysis_payload["summary"]
    nifti_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "nifti")
    nifti_metrics = {metric["label"]: metric["value"] for metric in nifti_analysis["metrics"]}
    assert nifti_metrics["Volume dimensions"] == "2 x 3 x 4"
    assert nifti_metrics["Voxel count"] == "24"
    assert nifti_metrics["Intensity range"] == "0 to 23"
    assert nifti_metrics["Mean intensity"] == "11.5"

    png_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "png")
    png_metrics = {metric["label"]: metric["value"] for metric in png_analysis["metrics"]}
    assert png_metrics["Image dimensions"] == "1 x 1"
    assert png_metrics["Bit depth"] == "8"

    jpeg_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "jpeg")
    jpeg_metrics = {metric["label"]: metric["value"] for metric in jpeg_analysis["metrics"]}
    assert jpeg_metrics["Image dimensions"] == "1 x 1"
    assert jpeg_metrics["Precision"] == "8"
    assert jpeg_metrics["Color components"] == "1"

    tiff_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "tiff")
    tiff_metrics = {metric["label"]: metric["value"] for metric in tiff_analysis["metrics"]}
    assert tiff_metrics["Image dimensions"] == "2 x 3"
    assert tiff_metrics["Bits per sample"] == "8"

    nrrd_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "nrrd")
    nrrd_metrics = {metric["label"]: metric["value"] for metric in nrrd_analysis["metrics"]}
    assert nrrd_metrics["Volume dimensions"] == "2 x 3 x 4"
    assert nrrd_metrics["NRRD type"] == "uint8"
    assert nrrd_metrics["Encoding"] == "raw"
    assert nrrd_metrics["Voxel count"] == "24"
    assert nrrd_metrics["Intensity range"] == "0 to 23"
    assert nrrd_metrics["Mean intensity"] == "11.5"


def test_local_imaging_import_supports_paired_nifti_hdr_img(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    header_bytes, voxel_bytes = make_test_paired_nifti_bytes()

    response = client.post(
        "/api/local-imaging/import",
        data={
            "relativePaths": json.dumps(
                ["case-p/paired.hdr", "case-p/paired.img"],
            ),
        },
        files=[
            ("files", ("paired.hdr", header_bytes, "application/octet-stream")),
            ("files", ("paired.img", voxel_bytes, "application/octet-stream")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 2
    assert payload["rejectedFiles"] == 0
    imported = payload["importedStudies"][0]
    assert imported["formats"] == ["nifti", "nifti-data"]
    assert imported["fileCount"] == 2

    manifest_path = next(tmp_path.glob("import-*/manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    header_entry = next(entry for entry in manifest["files"] if entry["relativePath"] == "case-p/paired.hdr")
    data_entry = next(entry for entry in manifest["files"] if entry["relativePath"] == "case-p/paired.img")
    assert header_entry["pairedRelativePath"] == "case-p/paired.img"
    assert header_entry["pairedStoredPath"] == data_entry["storedPath"]
    assert data_entry["format"] == "nifti-data"

    assets_response = client.get(
        f"/api/local-imaging/studies/{imported['studyInstanceUID']}/assets",
    )
    assert assets_response.status_code == 200
    assets_payload = assets_response.json()
    assert assets_payload["formats"] == ["nifti", "nifti-data"]
    assert assets_payload["fileCount"] == 2
    findings = {finding["label"]: finding["value"] for finding in assets_payload["findings"]}
    assert "2 x 3 x 4 voxels" in findings["NIFTI volume"]
    assert findings["Paired NIFTI data files"] == "1"

    assets = assets_payload["assets"]
    header_asset = next(asset for asset in assets if asset["format"] == "nifti")
    data_asset = next(asset for asset in assets if asset["format"] == "nifti-data")
    assert header_asset["relativePath"] == "case-p/paired.hdr"
    assert header_asset["previewSupported"] is True
    assert header_asset["analysisSupported"] is True
    assert header_asset["previewSlices"] == {"axial": 4, "coronal": 3, "sagittal": 2}
    assert data_asset["relativePath"] == "case-p/paired.img"
    assert data_asset["previewSupported"] is False
    assert data_asset["analysisSupported"] is False

    preview_response = client.get(f"{header_asset['previewUrl']}?axis=coronal&slice=1")
    assert preview_response.status_code == 200
    assert preview_response.headers["content-type"].startswith("image/svg+xml")
    assert b"NIFTI coronal slice 2 preview" in preview_response.content

    analysis_response = client.get(
        f"/api/local-imaging/studies/{imported['studyInstanceUID']}/analysis",
    )
    assert analysis_response.status_code == 200
    analysis_payload = analysis_response.json()
    header_analysis = next(
        item for item in analysis_payload["analyses"] if item["relativePath"] == "case-p/paired.hdr"
    )
    header_metrics = {metric["label"]: metric["value"] for metric in header_analysis["metrics"]}
    assert header_metrics["Voxel count"] == "24"
    assert header_metrics["Intensity range"] == "0 to 23"
    assert header_metrics["Mean intensity"] == "11.5"
    data_analysis = next(
        item for item in analysis_payload["analyses"] if item["relativePath"] == "case-p/paired.img"
    )
    assert data_analysis["metrics"] == []
    assert "matching .hdr" in data_analysis["summary"]


def test_local_imaging_import_expands_zip_archives(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    study_uid = "1.2.826.0.1.3680043.10.54321.250"
    paired_header, paired_voxels = make_test_paired_nifti_bytes()
    archive_bytes = make_test_zip_bytes(
        [
            ("CASEZ/DICOMDIR", make_test_dicomdir_bytes([["SCAN1DCM"]])),
            ("CASEZ/SCAN1DCM", make_test_dicom_bytes(study_uid=study_uid)),
            ("NIFTI/volume.nii", make_test_nifti_bytes()),
            ("NIFTI/paired.hdr", paired_header),
            ("NIFTI/paired.img", paired_voxels),
            ("README.txt", b"not a medical image"),
        ],
    )

    response = client.post(
        "/api/local-imaging/import",
        data={"relativePaths": json.dumps(["archives/case.zip"])},
        files=[("files", ("case.zip", archive_bytes, "application/zip"))],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 5
    assert payload["rejectedFiles"] == 1
    assert any("Expanded archive case.zip into 6 file(s)." == warning for warning in payload["warnings"])
    assert len(payload["importedStudies"]) == 2

    dicom_import = next(study for study in payload["importedStudies"] if "dicom" in study["formats"])
    assert dicom_import["studyInstanceUID"] == study_uid
    assert dicom_import["formats"] == ["dicom", "dicomdir"]
    assert dicom_import["fileCount"] == 2

    nifti_import = next(study for study in payload["importedStudies"] if "nifti" in study["formats"])
    assert nifti_import["formats"] == ["nifti", "nifti-data"]
    assert nifti_import["fileCount"] == 3

    manifest_path = next(tmp_path.glob("import-*/manifest.json"))
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    relative_paths = {entry["relativePath"] for entry in manifest["files"]}
    assert "archives/case/CASEZ/DICOMDIR" in relative_paths
    assert "archives/case/CASEZ/SCAN1DCM" in relative_paths
    assert "archives/case/NIFTI/volume.nii" in relative_paths
    assert "archives/case/NIFTI/paired.hdr" in relative_paths
    assert "archives/case/NIFTI/paired.img" in relative_paths
    assert "archives/case/README.txt" not in relative_paths

    assets_response = client.get(
        f"/api/local-imaging/studies/{nifti_import['studyInstanceUID']}/assets",
    )
    assert assets_response.status_code == 200
    assets_payload = assets_response.json()
    findings = {finding["label"]: finding["value"] for finding in assets_payload["findings"]}
    assert findings["Paired NIFTI data files"] == "1"

    analysis_response = client.get(
        f"/api/local-imaging/studies/{nifti_import['studyInstanceUID']}/analysis",
    )
    assert analysis_response.status_code == 200
    analysis_payload = analysis_response.json()
    archive_nifti_analysis = next(
        item for item in analysis_payload["analyses"] if item["relativePath"].endswith("NIFTI/volume.nii")
    )
    metrics = {metric["label"]: metric["value"] for metric in archive_nifti_analysis["metrics"]}
    assert metrics["Voxel count"] == "24"
    assert metrics["Mean intensity"] == "11.5"


def test_local_imaging_import_groups_dicomdir_with_referenced_dicom(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    study_uid = "1.2.826.0.1.3680043.10.54321.200"

    response = client.post(
        "/api/local-imaging/import",
        data={
            "relativePaths": json.dumps(
                ["CASEA/DICOMDIR", "CASEA/SCAN1DCM"],
            ),
        },
        files=[
            ("files", ("DICOMDIR", make_test_dicomdir_bytes(), "application/dicom")),
            ("files", ("SCAN1DCM", make_test_dicom_bytes(study_uid=study_uid), "application/dicom")),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 2
    assert payload["rejectedFiles"] == 0
    assert len(payload["importedStudies"]) == 1
    imported = payload["importedStudies"][0]
    assert imported["studyInstanceUID"] == study_uid
    assert imported["formats"] == ["dicom", "dicomdir"]
    assert imported["warnings"] == []


def test_local_imaging_import_links_multistudy_dicomdir_records(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    study_uid_a = "1.2.826.0.1.3680043.10.54321.210"
    study_uid_b = "1.2.826.0.1.3680043.10.54321.220"

    response = client.post(
        "/api/local-imaging/import",
        data={
            "relativePaths": json.dumps(
                [
                    "MEDIA/DICOMDIR",
                    "MEDIA/CASEA/SCAN1DCM",
                    "MEDIA/CASEB/SCAN2DCM",
                ],
            ),
        },
        files=[
            (
                "files",
                (
                    "DICOMDIR",
                    make_test_dicomdir_bytes(
                        references=[
                            ["CASEA", "SCAN1DCM"],
                            ["CASEB", "SCAN2DCM"],
                        ],
                    ),
                    "application/dicom",
                ),
            ),
            (
                "files",
                (
                    "SCAN1DCM",
                    make_test_dicom_bytes(study_uid=study_uid_a),
                    "application/dicom",
                ),
            ),
            (
                "files",
                (
                    "SCAN2DCM",
                    make_test_dicom_bytes(study_uid=study_uid_b),
                    "application/dicom",
                ),
            ),
        ],
    )

    assert response.status_code == 200
    payload = response.json()
    assert payload["acceptedFiles"] == 3
    assert payload["rejectedFiles"] == 0
    assert payload["warnings"] == []
    assert len(payload["importedStudies"]) == 2

    imports_by_uid = {
        study["studyInstanceUID"]: study
        for study in payload["importedStudies"]
    }
    assert set(imports_by_uid) == {study_uid_a, study_uid_b}
    for study_uid in (study_uid_a, study_uid_b):
        imported = imports_by_uid[study_uid]
        assert imported["formats"] == ["dicom", "dicomdir"]
        assert imported["fileCount"] == 2
        assert imported["warnings"] == []

        assets_response = client.get(f"/api/local-imaging/studies/{study_uid}/assets")
        assert assets_response.status_code == 200
        assets = assets_response.json()["assets"]
        formats = [asset["format"] for asset in assets]
        assert formats.count("dicomdir") == 1
        assert formats.count("dicom") == 1
        dicomdir_asset = next(asset for asset in assets if asset["format"] == "dicomdir")
        assert dicomdir_asset["studyInstanceUID"] == study_uid

    manifests = list(tmp_path.glob("import-*/manifest.json"))
    assert len(manifests) == 1
    manifest = json.loads(manifests[0].read_text(encoding="utf-8"))
    dicomdir_entry = next(file for file in manifest["files"] if file["format"] == "dicomdir")
    assert sorted(dicomdir_entry["localStudyInstanceUIDs"]) == sorted([study_uid_a, study_uid_b])
    assert dicomdir_entry["localStudyInstanceUID"] in {study_uid_a, study_uid_b}


def test_local_dicomweb_serves_imported_dicom_metadata_and_frame(
    monkeypatch,
    tmp_path,
) -> None:
    login()
    monkeypatch.setattr(server_module.settings, "local_imaging_enabled", True)
    monkeypatch.setattr(server_module.settings, "local_imaging_storage_dir", str(tmp_path))
    study_uid = "1.2.826.0.1.3680043.10.54321.300"
    series_uid = "1.2.826.0.1.3680043.10.54321.301"
    sop_uid = "1.2.826.0.1.3680043.10.54321.302"

    import_response = client.post(
        "/api/local-imaging/import",
        data={"relativePaths": json.dumps(["case-a/scan.dcm"])},
        files=[
            (
                "files",
                (
                    "scan.dcm",
                    make_test_dicom_bytes(
                        study_uid=study_uid,
                        series_uid=series_uid,
                        sop_uid=sop_uid,
                    ),
                    "application/dicom",
                ),
            ),
        ],
    )
    assert import_response.status_code == 200

    assets_response = client.get(f"/api/local-imaging/studies/{study_uid}/assets")
    assert assets_response.status_code == 200
    assets_payload = assets_response.json()
    assert assets_payload["formats"] == ["dicom"]
    assert assets_payload["assets"][0]["viewerSupported"] is True
    assert assets_payload["assets"][0]["analysisSupported"] is True
    assert any(finding["label"] == "DICOM instances" for finding in assets_payload["findings"])

    studies_response = client.get(f"/dicom-web/studies?StudyInstanceUID={study_uid}")
    assert studies_response.status_code == 200
    assert studies_response.json()[0]["0020000D"]["Value"] == [study_uid]

    metadata_response = client.get(
        f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/metadata"
    )
    assert metadata_response.status_code == 200
    metadata = metadata_response.json()[0]
    assert metadata["0020000D"]["Value"] == [study_uid]
    assert metadata["0020000E"]["Value"] == [series_uid]
    assert metadata["00080018"]["Value"] == [sop_uid]
    assert metadata["7FE00010"]["BulkDataURI"].endswith("/bulkdata/7FE00010")

    frame_response = client.get(
        f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/frames/1"
    )
    assert frame_response.status_code == 200
    assert frame_response.headers["content-type"].startswith("multipart/related")
    assert b"\x00\x01\x02\x03" in frame_response.content

    bulk_response = client.get(
        f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}/bulkdata/7FE00010"
    )
    assert bulk_response.status_code == 200
    assert bulk_response.headers["content-type"].startswith("multipart/related")
    assert b"\x00\x01\x02\x03" in bulk_response.content

    instance_response = client.get(
        f"/dicom-web/studies/{study_uid}/series/{series_uid}/instances/{sop_uid}"
    )
    assert instance_response.status_code == 200
    assert instance_response.headers["content-type"].startswith("multipart/related")
    assert b"DICM" in instance_response.content

    analysis_response = client.get(f"/api/local-imaging/studies/{study_uid}/analysis")
    assert analysis_response.status_code == 200
    analysis_payload = analysis_response.json()
    dicom_analysis = next(item for item in analysis_payload["analyses"] if item["format"] == "dicom")
    dicom_metrics = {metric["label"]: metric["value"] for metric in dicom_analysis["metrics"]}
    assert dicom_metrics["Frame dimensions"] == "2 x 2"
    assert dicom_metrics["Intensity range"] == "0 to 3"
    assert dicom_metrics["Mean intensity"] == "1.5"


def test_imaging_launch_returns_opaque_token_and_viewer_url_without_phi_in_url() -> None:
    login()

    payload = {
        "studyInstanceUID": "1.2.840.113619.2.55.3.604688123.1234.1700000001.101",
    }

    response = client.post("/api/imaging/launch", json=payload)
    assert response.status_code == 200

    body = response.json()
    assert body["signature"]
    assert body["launchToken"].startswith("launch-")
    assert body["viewerUrl"].startswith("http://localhost:3000/viewer/?launch=")
    assert "study=" not in body["viewerUrl"]
    assert body["context"]["studyInstanceUID"] == payload["studyInstanceUID"]
    assert body["context"]["patientRef"] == "Patient/example-ct-01"


def test_launch_resolution_returns_viewer_runtime_and_same_origin_dicomweb_roots() -> None:
    login()

    launch_response = client.post(
        "/api/imaging/launch",
        json={
            "studyInstanceUID": "1.2.840.113619.2.55.3.604688123.1234.1700000002.201",
        },
    )
    assert launch_response.status_code == 200

    launch_token = launch_response.json()["launchToken"]
    resolve_response = client.get(f"/api/imaging/launch/resolve?launch={launch_token}")
    assert resolve_response.status_code == 200

    payload = resolve_response.json()
    assert payload["launchToken"] == launch_token
    assert payload["context"]["studyInstanceUID"] == "1.2.840.113619.2.55.3.604688123.1234.1700000002.201"
    assert payload["studyWadoRsUri"].endswith(payload["context"]["studyInstanceUID"])
    runtime = payload["viewerRuntime"]
    assert runtime["viewerKind"] == "ohif"
    assert runtime["viewerBasePath"] == "/viewer"
    assert runtime["authMode"] == "local"
    assert runtime["qidoRoot"] == "/dicom-web"
    assert runtime["wadoRoot"] == "/dicom-web"
    assert runtime["stowRoot"] == ""
    assert runtime["featureFlags"]["directStow"] is False
    assert runtime["featureFlags"]["localFileImport"] is False


def test_imaging_launch_preserves_existing_viewer_base_url_query(monkeypatch) -> None:
    login()
    monkeypatch.setattr(
        server_module.settings,
        "viewer_base_url",
        "http://localhost:3000/viewer/?theme=clinical&showStudyList=false",
    )

    response = client.post(
        "/api/imaging/launch",
        json={"studyInstanceUID": "1.2.840.113619.2.55.3.604688123.1234.1700000001.101"},
    )
    assert response.status_code == 200

    viewer_url = response.json()["viewerUrl"]
    params = dict(parse_qsl(urlsplit(viewer_url).query, keep_blank_values=True))
    assert params["theme"] == "clinical"
    assert params["showStudyList"] == "false"
    assert params["launch"].startswith("launch-")


def test_active_ai_mode_is_rejected_by_default() -> None:
    login()

    payload = {
        "kind": "triage",
        "workflowMode": "active",
        "studyInstanceUID": "1.2.840.113619.2.55.3.604688123.1234.1700000001.101",
        "modelId": "triage-model",
        "modelVersion": "1.0.0",
        "inputHash": "abc123",
    }

    response = client.post("/api/ai/jobs", json=payload)
    assert response.status_code == 409
    assert "disabled" in response.json()["detail"].lower()


def test_ai_sidebar_backend_session_and_turn_are_audited() -> None:
    isolated_client = TestClient(app)

    unauthenticated = isolated_client.get("/api/ai/sidebar/capabilities")
    assert unauthenticated.status_code == 401

    login_response = isolated_client.post(
        "/api/auth/local-login",
        json={"username": "demo-radiologist"},
    )
    assert login_response.status_code == 200

    capabilities = isolated_client.get("/api/ai/sidebar/capabilities")
    assert capabilities.status_code == 200
    capability_body = capabilities.json()
    assert capability_body["backendBound"] is True
    assert capability_body["voiceFirst"] is True
    assert capability_body["orchestrationMode"] == "stub"

    study_uid = "7.7.7.7.20260613.1"
    session_response = isolated_client.post(
        "/api/ai/sidebar/sessions",
        json={
            "viewerContext": {
                "studyInstanceUID": study_uid,
                "route": "/viewer/dicomlocal",
                "privacyClass": "local-only",
            }
        },
    )
    assert session_response.status_code == 200
    session_body = session_response.json()
    assert session_body["sessionId"].startswith("ais-")
    assert session_body["backendBound"] is True

    turn_response = isolated_client.post(
        f"/api/ai/sidebar/sessions/{session_body['sessionId']}/messages",
        json={
            "text": "Segment the liver if the loaded study supports it.",
            "inputSource": "voice",
            "viewerContext": {
                "studyInstanceUID": study_uid,
                "route": "/viewer/dicomlocal",
                "privacyClass": "local-only",
            },
            "attachments": [
                {
                    "id": "segmentation-1",
                    "kind": "segmentation",
                    "label": "segmentation",
                    "metadata": {},
                }
            ],
        },
    )
    assert turn_response.status_code == 200
    turn_body = turn_response.json()
    assert turn_body["turnId"].startswith("aiturn-")
    assert turn_body["persisted"] is False
    assert turn_body["assistantMessage"]["modelId"] == "radsysx-ai-sidebar-orchestrator"
    assert "Nemotron ASR" in turn_body["assistantMessage"]["text"]
    assert "BioMedParse" in turn_body["assistantMessage"]["text"]

    workspace_response = isolated_client.get(f"/api/studies/{study_uid}/workspace")
    assert workspace_response.status_code == 200
    audit = workspace_response.json()["audit"]
    assert any(
        event["action"] == "RUN_AI" and event["resourceId"] == turn_body["turnId"]
        for event in audit
    )


def test_workspace_round_trip_persists_report_ai_job_and_internal_derived_result() -> None:
    login()
    study_uid = "9.9.9.9.20260308.1"

    report_response = client.post(
        "/api/reports/draft",
        json={
            "studyInstanceUID": study_uid,
            "findingsSummary": "Stable postoperative changes. No acute hemorrhage.",
            "impression": "No acute intracranial abnormality.",
            "status": "draft",
        },
    )
    assert report_response.status_code == 200
    report_id = report_response.json()["reportId"]
    assert report_response.json()["authorUserId"] == "demo-radiologist"

    ai_response = client.post(
        "/api/ai/jobs",
        json={
            "kind": "triage",
            "workflowMode": "shadow",
            "studyInstanceUID": study_uid,
            "modelId": "triage-model",
            "modelVersion": "1.0.0",
            "inputHash": "workspace-round-trip",
        },
    )
    assert ai_response.status_code == 200
    job_id = ai_response.json()["jobId"]
    assert ai_response.json()["requestedBy"] == "demo-radiologist"

    derived_response = client.post(
        "/api/derived-results",
        json={
            "objects": [
                {
                    "objectType": "sr",
                    "studyInstanceUID": study_uid,
                    "storageClass": "SR",
                    "payloadRef": "derived/sr/test-workspace-round-trip",
                    "metadata": {"source": "pytest"},
                }
            ],
        },
    )
    assert derived_response.status_code == 200
    assert derived_response.json()["result"]["stored"] == [
        "derived/sr/test-workspace-round-trip"
    ]

    workspace_response = client.get(f"/api/studies/{study_uid}/workspace")
    assert workspace_response.status_code == 200

    workspace = workspace_response.json()
    assert workspace["worklistRow"]["studyInstanceUID"] == study_uid
    assert workspace["reports"][0]["reportId"] == report_id
    assert workspace["aiJobs"][0]["jobId"] == job_id
    assert workspace["derivedResults"][0]["payloadRef"] == "derived/sr/test-workspace-round-trip"
    audit_actions = {event["action"] for event in workspace["audit"]}
    assert {"SAVE_REPORT", "RUN_AI", "STORE_SEG"}.issubset(audit_actions)


def test_stow_endpoint_persists_backend_registered_refs(monkeypatch) -> None:
    login()
    study_uid = "1.2.840.113619.2.55.3.604688123.1234.1700000001.101"
    captured_stream = None

    async def fake_store_uploaded_instances(request, files):
        nonlocal captured_stream
        assert request.study_instance_uid == study_uid
        assert len(files) == 1
        assert files[0].filename == "seg.dcm"
        captured_stream = files[0].stream
        assert captured_stream.read(4) == b"DICM"
        captured_stream.seek(0)
        return StoreResult(
            stored=[f"/dicom-web/studies/{study_uid}/instances/1.2.3.4"],
            warnings=[],
        )

    monkeypatch.setattr(
        clinical_service._dicomweb,
        "store_uploaded_instances",
        fake_store_uploaded_instances,
    )

    response = client.post(
        "/api/derived-results/stow",
        data={
            "studyInstanceUID": study_uid,
            "objectType": "seg",
            "storageClass": "SEG",
            "metadata": "{\"source\":\"pytest-stow\"}",
        },
        files={"files": ("seg.dcm", b"DICMSEG", "application/dicom")},
    )
    assert response.status_code == 200
    body = response.json()
    assert body["result"]["stored"] == [f"/dicom-web/studies/{study_uid}/instances/1.2.3.4"]
    assert captured_stream is not None
    assert captured_stream.closed is True

    workspace_response = client.get(f"/api/studies/{study_uid}/workspace")
    assert workspace_response.status_code == 200
    workspace = workspace_response.json()
    assert workspace["derivedResults"][0]["storageClass"] == "SEG"
    assert workspace["derivedResults"][0]["metadata"]["source"] == "pytest-stow"
    assert workspace["derivedResults"][0]["metadata"]["stowFileName"] == "seg.dcm"


def test_stow_endpoint_rejects_unsupported_content_type() -> None:
    login()

    response = client.post(
        "/api/derived-results/stow",
        data={
            "studyInstanceUID": "1.2.840.113619.2.55.3.604688123.1234.1700000001.101",
            "objectType": "seg",
            "storageClass": "SEG",
            "contentType": "text/plain",
            "metadata": "{\"source\":\"pytest-stow-invalid\"}",
        },
        files={"files": ("seg.dcm", b"DICMSEG", "application/dicom")},
    )

    assert response.status_code == 400
    assert "unsupported dicom stow contenttype" in response.json()["detail"].lower()


def test_initialize_fhir_server_awaits_async_initializer() -> None:
    class FakeFHIRServer:
        def __init__(self) -> None:
            self.initialized = False

        async def initialize(self) -> bool:
            self.initialized = True
            return True

    fake_server = FakeFHIRServer()
    assert asyncio.run(server_module._initialize_fhir_server(fake_server)) is True
    assert fake_server.initialized is True


def test_fhir_tool_dispatch_matches_server_api(monkeypatch) -> None:
    class FakeFHIRServer:
        available = True

        def __init__(self) -> None:
            self.calls: list[tuple[str, object, object]] = []

        async def list_resources(self, uri_pattern: str, mime_type: str | None) -> list[str]:
            self.calls.append(("list_resources", uri_pattern, mime_type))
            return ["Patient", "Observation"]

        async def call_tool(self, tool_name: str, params: dict[str, object]) -> dict[str, object]:
            self.calls.append(("call_tool", tool_name, params))
            return {"tool": tool_name, "params": params}

    fake_server = FakeFHIRServer()
    monkeypatch.setattr(server_module, "fhir_server", fake_server)

    list_response = client.post("/fhir/tool", json={"tool": "list_fhir_resources", "params": {}})
    assert list_response.status_code == 200
    assert list_response.json() == {"result": ["Patient", "Observation"]}

    demographics_response = client.post(
        "/fhir/tool",
        json={"tool": "get_patient_demographics", "params": {"patient_id": "example"}},
    )
    assert demographics_response.status_code == 200
    assert demographics_response.json() == {
        "result": {
            "tool": "get_patient_demographics",
            "params": {"patient_id": "example"},
        }
    }
    assert fake_server.calls == [
        ("list_resources", "", None),
        ("call_tool", "get_patient_demographics", {"patient_id": "example"}),
    ]


def test_seed_orthanc_logs_without_identifiers(monkeypatch, capsys) -> None:
    pytest.importorskip("pydicom")

    try:
        import backend.clinical.seed_orthanc as seed_orthanc_module  # type: ignore
    except Exception:
        import clinical.seed_orthanc as seed_orthanc_module  # type: ignore

    class _Response:
        def __init__(self, payload):
            self._payload = payload

        def raise_for_status(self):
            return None

        def json(self):
            return self._payload

    class _FakeClient:
        def __init__(self, *args, **kwargs):
            return None

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return None

        def get(self, path, params=None):
            return _Response([])

        def post(self, path, content=None, headers=None):
            return _Response({})

    monkeypatch.setattr(seed_orthanc_module.httpx, "Client", _FakeClient)

    seed_orthanc_module.main()

    output = capsys.readouterr().out
    assert "Seeded sample study 1 (CT)" in output
    assert "Seeded sample study 2 (MR)" in output
    for study in seed_orthanc_module.SEED_STUDIES:
        assert study.study_uid not in output
        assert study.patient_name not in output
        assert study.accession_number not in output

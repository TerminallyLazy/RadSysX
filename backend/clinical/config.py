from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import cast

from .contracts import AppMode, AuthMode, WorkflowMode
from .db import default_database_url

INSECURE_DEVELOPMENT_SECRET = "development-only-secret-change-me"
COOKIE_SAMESITE_VALUES = {"lax", "strict", "none"}


class ClinicalPlatformSettings:
    def __init__(self) -> None:
        self.app_mode = self._read_mode("RADSYSX_APP_MODE", AppMode.RESEARCH)
        self.allowed_origins = self._read_csv(
            "RADSYSX_ALLOWED_ORIGINS",
            ["http://localhost:3000", "http://localhost:8000"],
        )
        self.viewer_base_url = os.getenv(
            "RADSYSX_VIEWER_BASE_URL",
            "http://localhost:3000/viewer",
        )
        self.viewer_kind = os.getenv("RADSYSX_VIEWER_KIND", "ohif")
        self.viewer_base_path = os.getenv("RADSYSX_VIEWER_BASE_PATH", "/viewer")
        self.auth_mode = self._read_auth_mode("RADSYSX_AUTH_MODE", AuthMode.LOCAL)
        self.clinical_api_secret = self._read_signing_secret(
            "RADSYSX_CLINICAL_API_SECRET",
            fallback=INSECURE_DEVELOPMENT_SECRET,
            allow_fallback=not self.governed_runtime,
        )
        self.session_secret = self._read_signing_secret(
            "RADSYSX_SESSION_SECRET",
            fallback=self.clinical_api_secret,
            allow_fallback=True,
        )
        self.session_cookie_name = os.getenv(
            "RADSYSX_SESSION_COOKIE_NAME",
            "radsysx_clinical_session",
        )
        self.session_cookie_secure = self._read_bool(
            "RADSYSX_SESSION_COOKIE_SECURE",
            self.governed_runtime,
        )
        self.session_cookie_httponly = self._read_bool(
            "RADSYSX_SESSION_COOKIE_HTTP_ONLY",
            True,
        )
        self.session_cookie_samesite = self._read_samesite(
            "RADSYSX_SESSION_COOKIE_SAMESITE",
            "lax",
        )
        self.session_cookie_path = os.getenv("RADSYSX_SESSION_COOKIE_PATH", "/")
        self.session_cookie_domain = self._read_optional_str("RADSYSX_SESSION_COOKIE_DOMAIN")
        self.session_ttl_seconds = int(os.getenv("RADSYSX_SESSION_TTL_SECONDS", "28800"))
        self.clinical_database_url = os.getenv(
            "RADSYSX_CLINICAL_DATABASE_URL",
            default_database_url(),
        )
        self.launch_ttl_seconds = int(os.getenv("RADSYSX_LAUNCH_TTL_SECONDS", "900"))
        self.orthanc_base_url = os.getenv("RADSYSX_ORTHANC_DICOMWEB_URL", "").rstrip("/")
        self.orthanc_username = os.getenv("RADSYSX_ORTHANC_USERNAME")
        self.orthanc_password = os.getenv("RADSYSX_ORTHANC_PASSWORD")
        self.dicomweb_public_base_url = os.getenv(
            "RADSYSX_DICOMWEB_PUBLIC_BASE_URL",
            "/dicom-web",
        ).rstrip("/")
        self.dicomweb_qido_root = os.getenv(
            "RADSYSX_DICOMWEB_QIDO_ROOT",
            self.dicomweb_public_base_url or "/dicom-web",
        ).rstrip("/")
        self.dicomweb_wado_root = os.getenv(
            "RADSYSX_DICOMWEB_WADO_ROOT",
            self.dicomweb_public_base_url or "/dicom-web",
        ).rstrip("/")
        self.dicomweb_wado_uri_root = os.getenv(
            "RADSYSX_DICOMWEB_WADO_URI_ROOT",
            self.dicomweb_public_base_url or "/dicom-web",
        ).rstrip("/")
        self.dicomweb_stow_root = os.getenv(
            "RADSYSX_DICOMWEB_STOW_ROOT",
            self.dicomweb_public_base_url or "/dicom-web",
        ).rstrip("/")
        self.ai_default_workflow_mode = self._read_workflow_mode(
            "RADSYSX_AI_DEFAULT_WORKFLOW_MODE",
            WorkflowMode.SHADOW,
        )
        self.ai_allow_active = self._read_bool("RADSYSX_AI_ALLOW_ACTIVE", False)
        self.local_imaging_enabled = self._read_bool(
            "RADSYSX_LOCAL_IMAGING_ENABLED",
            False,
        )
        self.local_imaging_storage_dir = os.getenv(
            "RADSYSX_LOCAL_IMAGING_STORAGE_DIR",
            str(Path(__file__).resolve().parents[1] / "local-imaging-data"),
        )
        self.local_imaging_max_files = int(os.getenv("RADSYSX_LOCAL_IMAGING_MAX_FILES", "750"))
        self.local_imaging_max_file_bytes = int(
            os.getenv("RADSYSX_LOCAL_IMAGING_MAX_FILE_BYTES", str(1024 * 1024 * 512)),
        )

        if self.session_cookie_samesite == "none" and not self.session_cookie_secure:
            raise RuntimeError(
                "RADSYSX_SESSION_COOKIE_SAMESITE='none' requires "
                "RADSYSX_SESSION_COOKIE_SECURE=true."
            )

    @property
    def allow_wildcard_cors(self) -> bool:
        return self.app_mode == AppMode.RESEARCH

    @property
    def experimental_routes_enabled(self) -> bool:
        return self.app_mode == AppMode.RESEARCH

    @property
    def governed_runtime(self) -> bool:
        return self.app_mode in {AppMode.PILOT, AppMode.CLINICAL}

    @staticmethod
    def _read_csv(name: str, default: list[str]) -> list[str]:
        raw = os.getenv(name)
        if not raw:
            return default
        return [item.strip() for item in raw.split(",") if item.strip()]

    @staticmethod
    def _read_optional_str(name: str) -> str | None:
        raw = os.getenv(name)
        if raw is None:
            return None
        value = raw.strip()
        return value or None

    @staticmethod
    def _read_bool(name: str, default: bool) -> bool:
        raw = os.getenv(name)
        if raw is None:
            return default
        return raw.strip().lower() in {"1", "true", "yes", "on"}

    @staticmethod
    def _read_samesite(name: str, default: str) -> str:
        raw = os.getenv(name, default).strip().lower()
        if raw not in COOKIE_SAMESITE_VALUES:
            return default
        return raw

    @staticmethod
    def _read_mode(name: str, default: AppMode) -> AppMode:
        raw = os.getenv(name, default.value).strip().lower()
        try:
            return AppMode(raw)
        except ValueError:
            return default

    @staticmethod
    def _read_workflow_mode(name: str, default: WorkflowMode) -> WorkflowMode:
        raw = os.getenv(name, default.value).strip().lower()
        try:
            return WorkflowMode(raw)
        except ValueError:
            return default

    @staticmethod
    def _read_auth_mode(name: str, default: AuthMode) -> AuthMode:
        raw = os.getenv(name, default.value).strip().lower()
        try:
            return AuthMode(raw)
        except ValueError:
            return default

    def _read_signing_secret(
        self,
        name: str,
        *,
        fallback: str,
        allow_fallback: bool,
    ) -> str:
        raw = os.getenv(name)
        value = raw.strip() if raw is not None else ""
        if not value:
            if self.governed_runtime and not allow_fallback:
                raise RuntimeError(
                    f"{name} must be set when RADSYSX_APP_MODE is "
                    f"'{self.app_mode.value}'. Governed runtimes may not rely on the "
                    "insecure development signing secret."
                )
            value = fallback

        if self.governed_runtime and value == INSECURE_DEVELOPMENT_SECRET:
            raise RuntimeError(
                f"{name} may not use the insecure development signing secret when "
                f"RADSYSX_APP_MODE is '{self.app_mode.value}'. Set an explicit secret "
                "through the environment."
            )
        return value


@lru_cache(maxsize=1)
def get_settings() -> ClinicalPlatformSettings:
    return cast(ClinicalPlatformSettings, ClinicalPlatformSettings())

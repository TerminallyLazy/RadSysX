"""Read AI settings only in the backend; never export file secrets to child builds."""
from __future__ import annotations

import importlib.metadata
import os
from pathlib import Path
from pydantic import SecretStr

PROVIDER_PROFILES = {
    "gemini": {"id": "gemini", "label": "Gemini Live", "modelId": "gemini-3.8-live-extended-thinking",
               "inputSampleRate": 16000, "outputSampleRate": 24000, "screen": True, "tools": True},
    "openai": {"id": "openai", "label": "OpenAI Realtime", "modelId": "gpt-realtime-2.1-mini",
               "inputSampleRate": 24000, "outputSampleRate": 24000, "screen": True, "tools": True},
}


def profile_for_model(model):
    # Persisted exact model identity binds the provider and wire format without a
    # destructive migration of existing session/history tables.
    for profile in PROVIDER_PROFILES.values():
        if profile["modelId"] == model:
            return dict(profile)
    raise ValueError("Unsupported stored AI model. Start a new session.")


class AISettings:
    def __init__(self, app_mode="pilot"):
        values = {}
        env_file = Path(__file__).resolve().parents[2] / ".env.ai"
        if env_file.is_file():
            try:
                from dotenv import dotenv_values
                values = {k: v for k, v in dotenv_values(env_file, interpolate=False).items() if v is not None}
            except ImportError:
                pass
        def setting(name, default=""):
            return os.environ.get(name, values.get(name, default))
        self.api_key = setting("RADSYSX_GEMINI_API_KEY")
        self.openai_api_key = setting("RADSYSX_OPENAI_API_KEY")
        self.nvidia_api_key = setting("RADSYSX_NVIDIA_API_KEY")
        self.research_provider = setting("RADSYSX_RESEARCH_PROVIDER", "gemini")
        self.key_store_dir = setting("RADSYSX_AI_KEY_STORE_DIR")
        self.credential_errors = set()
        self.openai_voice = "marin"
        self.model = "gemini-3.8-live-extended-thinking"
        self.research_model = setting("RADSYSX_NIM_RESEARCH_MODEL") if self.research_provider == "nvidia_nim" else "gemini-3.8-flash"
        self.enabled = setting("RADSYSX_AI_ENABLED", "true").lower() in {"1", "true", "yes"}
        self.app_mode = app_mode
        self.typesafe_api_key = SecretStr(setting("RADSYSX_TYPESAFE_AI_API_KEY")
            if self.enabled and app_mode in {"research", "pilot"} else "")
        self.evidence_dir = setting("RADSYSX_AI_EVIDENCE_DIR")
        self.codex_enabled = setting("RADSYSX_CODEX_ENABLED", "false").lower() in {"1", "true", "yes"}
        self.codex_ready = False
        self.voice = setting("RADSYSX_GEMINI_VOICE", "Puck")

    def research_configuration(self):
        from .ai_research_worker import validate_research_model
        if not self.enabled or self.app_mode not in {"research", "pilot"}:
            raise ValueError("Research disabled")
        validate_research_model(self.research_provider, self.research_model)
        if self.research_provider == "codex":
            if not self.codex_enabled or not self.codex_ready: raise ValueError("ChatGPT sign-in required")
            return "codex", "", self.research_model
        key = self.nvidia_api_key if self.research_provider == "nvidia_nim" else self.api_key
        if not key or self.research_provider in self.credential_errors:
            raise ValueError("Research credential unavailable")
        return self.research_provider, key, self.research_model

    def readiness(self, provider_id="gemini"):
        if provider_id not in PROVIDER_PROFILES:
            return "unavailable", "Unknown AI provider. Choose a supported model."
        label = PROVIDER_PROFILES[provider_id]["label"]
        if not self.enabled or self.app_mode == "clinical":
            return "disabled", f"{label} is disabled for this runtime. This release supports synthetic/deidentified pilot use."
        if provider_id in self.credential_errors:
            return "unavailable", "Your saved API key could not be read. Restore private key storage or remove the saved key in Settings → API keys."
        key = self.api_key if provider_id == "gemini" else self.openai_api_key
        if not key:
            name = "RADSYSX_GEMINI_API_KEY" if provider_id == "gemini" else "RADSYSX_OPENAI_API_KEY"
            return "unavailable", f"Open Settings → API keys in the assistant panel to save your key. Deployments may also set {name} in the backend environment."
        try:
            package, expected = ("google-genai", "2.24.0") if provider_id == "gemini" else ("websockets", "16.1.1")
            if importlib.metadata.version(package) != expected:
                return "unavailable", "Run npm run desktop:bootstrap to install the supported AI dependencies."
        except importlib.metadata.PackageNotFoundError:
            return "unavailable", "Run npm run desktop:bootstrap to install AI dependencies."
        return "configured", f"{label} is configured. Start a synthetic/deidentified session to connect."

    def profiles(self):
        return [{**profile, "availability": self.readiness(identifier)[0], "reason": self.readiness(identifier)[1]}
                for identifier, profile in PROVIDER_PROFILES.items()]

"""Evaluation-only deployment settings; secrets are never serialized."""
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

from pydantic import SecretStr


@dataclass(frozen=True)
class EvaluationSettings:
    app_mode: str
    typesafe_key: SecretStr
    gemini_key: SecretStr
    nvidia_key: SecretStr = SecretStr("")


def check_network_mode(environ: Mapping[str,str]) -> str:
    mode = environ.get("RADSYSX_APP_MODE", "research")
    if mode not in {"research", "pilot"}:
        raise ValueError("evaluation_disabled")
    return mode


def load_settings(*, environ: Mapping[str,str], env_file: Path | None) -> EvaluationSettings:
    mode = check_network_mode(environ)
    values = {}
    if env_file is not None and env_file.is_file():
        from dotenv import dotenv_values
        values = dotenv_values(env_file, interpolate=False)
    def key(name):
        return SecretStr(environ.get(name, values.get(name) or ""))
    return EvaluationSettings(mode,key("RADSYSX_TYPESAFE_AI_API_KEY"),key("RADSYSX_GEMINI_API_KEY"),key("RADSYSX_NVIDIA_API_KEY"))

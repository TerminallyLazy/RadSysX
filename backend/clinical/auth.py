from __future__ import annotations

from dataclasses import dataclass
from datetime import timedelta

from itsdangerous import BadSignature, URLSafeSerializer

from .config import ClinicalPlatformSettings
from .contracts import SessionClaims, utc_now, to_iso_z, parse_iso_z


@dataclass(frozen=True)
class SeededPersona:
    sub: str
    username: str
    name: str
    roles: tuple[str, ...]
    scopes: tuple[str, ...]


SEEDED_PERSONAS: dict[str, SeededPersona] = {
    "demo-radiologist": SeededPersona(
        sub="user-demo-radiologist",
        username="demo-radiologist",
        name="Demo Radiologist",
        roles=("radiologist",),
        scopes=("study.read", "report.read", "report.write", "derived.write", "ai.run"),
    ),
    "attending-radiologist": SeededPersona(
        sub="user-attending-radiologist",
        username="attending-radiologist",
        name="Attending Radiologist",
        roles=("attending", "radiologist"),
        scopes=("study.read", "report.read", "report.write", "derived.write", "ai.run"),
    ),
    "qa-reviewer": SeededPersona(
        sub="user-qa-reviewer",
        username="qa-reviewer",
        name="QA Reviewer",
        roles=("qa",),
        scopes=("study.read", "report.read", "audit.read"),
    ),
}


class ClinicalSessionManager:
    def __init__(self, settings: ClinicalPlatformSettings) -> None:
        self._settings = settings
        self._serializer = URLSafeSerializer(
            settings.session_secret,
            salt="radsysx.clinical.session",
        )

    @property
    def cookie_name(self) -> str:
        return self._settings.session_cookie_name

    def issue_for_username(self, username: str) -> SessionClaims:
        persona = SEEDED_PERSONAS.get(username)
        if persona is None:
            available = ", ".join(sorted(SEEDED_PERSONAS))
            raise ValueError(f"Unknown local clinical user '{username}'. Available: {available}")

        expires_at = utc_now() + timedelta(seconds=self._settings.session_ttl_seconds)
        return SessionClaims(
            sub=persona.sub,
            username=persona.username,
            name=persona.name,
            roles=list(persona.roles),
            scopes=list(persona.scopes),
            expires_at=to_iso_z(expires_at),
        )

    def dumps(self, session: SessionClaims) -> str:
        return self._serializer.dumps(session.model_dump(by_alias=True))

    def loads(self, token: str | None) -> SessionClaims | None:
        if not token:
            return None

        try:
            payload = self._serializer.loads(token)
        except BadSignature:
            return None

        session = SessionClaims.model_validate(payload)
        if parse_iso_z(session.expires_at) <= utc_now():
            return None
        return session

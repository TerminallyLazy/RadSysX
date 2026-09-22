"""Owner-scoped encrypted API keys. Never expose key values or fragments."""
from __future__ import annotations

import json
import os
import stat
from pathlib import Path

from .ai_config import PROVIDER_PROFILES
from .models import AICredentialModel

MAX_KEY_LENGTH = 4096


class CredentialStoreError(RuntimeError):
    def __init__(self):
        super().__init__("Saved API key storage is unavailable. Check its private storage directory.")


def validate_api_key(value):
    if (not isinstance(value, str) or not 8 <= len(value) <= MAX_KEY_LENGTH
            or any(not 33 <= ord(character) <= 126 for character in value)):
        raise ValueError("Enter a valid API key without spaces or control characters.")
    return value


class AICredentialStore:
    def __init__(self, repository, directory=None):
        self.factory = repository._session_factory
        database = repository._engine.url.database
        if directory:
            path = Path(directory).expanduser().absolute()
        elif repository._engine.url.get_backend_name() == "sqlite" and database and database != ":memory:":
            # Canonicalize the trusted database parent (macOS /var is an OS
            # alias), never the credential directory or master key themselves.
            path = Path(database).absolute().parent.resolve() / ".ai-secrets"
        else:
            path = Path(__file__).resolve().parents[1] / ".ai-secrets"
        self.directory = path

    def _cipher(self, *, create=False):
        """Open private POSIX files without following directory/file symlinks."""
        directory_fd = key_fd = None
        try:
            from cryptography.fernet import Fernet
            if os.name != "posix":
                raise CredentialStoreError()
            # Do not resolve() first: that would erase evidence of symlinks.
            if any(path.is_symlink() for path in (self.directory, *self.directory.parents)):
                raise CredentialStoreError()
            if create:
                try:
                    self.directory.mkdir(mode=0o700)
                except FileExistsError:
                    pass
            directory_fd = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            info = os.fstat(directory_fd)
            if info.st_uid != os.geteuid() or stat.S_IMODE(info.st_mode) != 0o700:
                raise CredentialStoreError()
            try:
                key_fd = os.open("master.key", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            except FileNotFoundError:
                if not create:
                    raise CredentialStoreError()
                # Never generate a replacement master for existing ciphertext:
                # a lost key needs deliberate operator recovery or user removal.
                with self.factory() as db:
                    if db.query(AICredentialModel).first() is not None:
                        raise CredentialStoreError()
                try:
                    created = os.open("master.key", os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                      0o600, dir_fd=directory_fd)
                except FileExistsError:
                    pass  # A concurrent process created it; validate below.
                else:
                    try:
                        os.write(created, Fernet.generate_key())
                        os.fsync(created)
                    finally:
                        os.close(created)
                key_fd = os.open("master.key", os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory_fd)
            info = os.fstat(key_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_nlink != 1 or info.st_size != 44):
                raise CredentialStoreError()
            return Fernet(os.read(key_fd, 45))
        except Exception:
            raise CredentialStoreError() from None
        finally:
            if key_fd is not None:
                os.close(key_fd)
            if directory_fd is not None:
                os.close(directory_fd)

    def _saved(self, owner, provider):
        with self.factory() as db:
            row = db.get(AICredentialModel, (owner, provider))
            return row.ciphertext if row is not None else None

    def resolve(self, owner, provider, environment_key):
        ciphertext = self._saved(owner, provider)
        if ciphertext is None:
            return environment_key
        try:
            if not isinstance(ciphertext, str) or len(ciphertext) > 12000:
                raise CredentialStoreError()
            payload = json.loads(self._cipher().decrypt(ciphertext.encode("ascii")))
            if payload.get("owner") != owner or payload.get("provider") != provider:
                raise CredentialStoreError()
            return validate_api_key(payload.get("apiKey"))
        except Exception:
            raise CredentialStoreError() from None

    def status(self, owner, settings):
        try:
            self._cipher(create=True)
            available = True
        except CredentialStoreError:
            available = False
        providers = []
        for provider, profile in PROVIDER_PROFILES.items():
            environment = settings.api_key if provider == "gemini" else settings.openai_api_key
            saved = self._saved(owner, provider) is not None
            try:
                configured = bool(self.resolve(owner, provider, environment))
            except CredentialStoreError:
                configured = False
                available = False
            providers.append({"id": provider, "label": profile["label"], "configured": configured,
                              "source": "saved" if saved else "environment" if environment else "none",
                              "environmentConfigured": bool(environment)})
        return {"storageAvailable": available, "providers": providers}

    def save(self, owner, provider, api_key):
        validate_api_key(api_key)
        try:
            payload = json.dumps({"owner": owner, "provider": provider, "apiKey": api_key}).encode()
            ciphertext = self._cipher(create=True).encrypt(payload).decode("ascii")
            with self.factory() as db:
                row = db.get(AICredentialModel, (owner, provider))
                if row is None:
                    row = AICredentialModel(owner=owner, provider=provider, ciphertext=ciphertext)
                    db.add(row)
                else:
                    row.ciphertext = ciphertext
                db.commit()
        except Exception:
            raise CredentialStoreError() from None

    def delete(self, owner, provider):
        try:
            # Explicit deletion is allowed even after key-file loss, so an owner
            # can deliberately restore deployment fallback without decrypting.
            with self.factory() as db:
                row = db.get(AICredentialModel, (owner, provider))
                if row is not None:
                    db.delete(row)
                    db.commit()
        except Exception:
            raise CredentialStoreError() from None

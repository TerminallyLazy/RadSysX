import pytest


def test_process_precedence_empty_override_and_no_gemini_requirement(tmp_path):
    from backend.evidence_review.settings import load_settings
    path=tmp_path / '.env.ai'
    path.write_text('RADSYSX_TYPESAFE_AI_API_KEY=file-key\n')
    settings=load_settings(environ={"RADSYSX_TYPESAFE_AI_API_KEY":"process-key"},env_file=path)
    assert settings.typesafe_key.get_secret_value()=="process-key"
    assert not settings.gemini_key.get_secret_value()
    assert "process-key" not in repr(settings)
    assert not load_settings(environ={"RADSYSX_TYPESAFE_AI_API_KEY":""},env_file=path).typesafe_key.get_secret_value()


@pytest.mark.parametrize("mode",["clinical","invalid"])
def test_mode_rejected_before_file_read(mode,tmp_path):
    from backend.evidence_review.settings import load_settings
    with pytest.raises(ValueError):
        load_settings(environ={"RADSYSX_APP_MODE":mode},env_file=tmp_path/'missing')


def test_none_env_file_never_reads_dotenv(monkeypatch):
    import dotenv
    from backend.evidence_review.settings import load_settings
    monkeypatch.setattr(dotenv,"dotenv_values",lambda *a,**kw:pytest.fail("file read"))
    assert load_settings(environ={},env_file=None).app_mode=="research"

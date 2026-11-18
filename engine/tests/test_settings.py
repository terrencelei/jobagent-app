import json
import re
from pathlib import Path

import pytest

from jobagent import settings


def test_every_setting_has_a_valid_default():
    for s in settings.REGISTRY:
        value = settings.default(s.key)
        assert value is not None, s.key
        assert settings.coerce(s, value) == value or s.type == 'minutes_list', s.key


def test_save_validates_stores_and_publishes_effective_values():
    assert settings.save({'tuner.min_evidence': '30', 'review.model': 'opus'}) == ['tuner.min_evidence', 'review.model']
    assert settings.setting('tuner.min_evidence') == 30 and settings.model_id('review.model') == 'opus'
    published = json.loads(settings.settings_path().read_text())
    assert published['effective']['tuner.min_evidence'] == 30 and published['effective']['workday.mail_lookup_tries'] == 4
    with pytest.raises(ValueError, match='between'):
        settings.save({'tuner.disagreement_rate': 3})
    with pytest.raises(ValueError, match='choose'):
        settings.save({'review.model': 'gpt'})
    settings.save({}, reset=['tuner.min_evidence'])
    assert settings.setting('tuner.min_evidence') == 20
    settings.save({'workers.rate_limit_cooldowns': '30, 90'})
    assert settings.setting('workers.rate_limit_cooldowns') == [30.0, 90.0]


def test_setting_back_to_the_default_clears_the_override():
    settings.save({'review.batch': 6})
    settings.save({'review.batch': 4})
    assert 'review.batch' not in settings.overrides()


def test_yaml_backed_settings_override_the_config_files():
    from jobagent.config import load_profile_config, load_ranking_config
    base = load_profile_config().candidate['salary_threshold_annual']
    settings.save({'profile.salary_threshold_annual': 80000, 'ranking.senior_title_penalty': 10})
    assert load_profile_config().candidate['salary_threshold_annual'] == 80000 != base
    assert load_ranking_config().penalties['senior_title_penalty'] == 10


def test_application_agent_fallbacks_match_the_registry():
    """The Node side falls back to its own defaults when JobAgent is absent; they must agree."""
    root = Path.home() / 'application-agent'
    if not root.exists():
        pytest.skip('application-agent not installed alongside')
    code = '\n'.join(p.read_text() for p in list((root / 'src').glob('*.mjs')) + list((root / 'tools').glob('*.mjs')))
    found = dict(re.findall(r"setting\('([\w.]+)',\s*([\d.]+|true|false)\)", code))
    agent_keys = {s.key for s in settings.REGISTRY if s.used_by == 'application-agent'}
    assert agent_keys - {'workday.mail_model'} <= set(found), agent_keys - set(found)
    for key, fallback in found.items():
        if fallback in ('true', 'false'):
            assert settings.default(key) is (fallback == 'true'), key
        else:
            assert float(fallback) == float(settings.default(key)), key

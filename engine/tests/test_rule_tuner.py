from types import SimpleNamespace
from pathlib import Path
import shutil

import pytest
import yaml

from jobagent.processing import tracks
from jobagent.processing.tracks import track_specs
from jobagent.services import rule_tuner


@pytest.fixture
def dirs(tmp_path, monkeypatch):
    settings = SimpleNamespace(config_dir=tmp_path / 'config', data_dir=tmp_path / 'data')
    settings.config_dir.mkdir()
    # Load tracked baseline rules, never the applicant's live learned overlay.
    shutil.copyfile(Path(__file__).resolve().parent / 'fixtures' / 'config' / 'tracks.yaml',
                    settings.config_dir / 'tracks.yaml')
    monkeypatch.setattr(tracks, 'get_settings', lambda: settings)
    monkeypatch.setattr(rule_tuner, 'get_settings', lambda: settings)
    return settings


def row(title, truth, rules_fit, description='Required: Bachelor\'s degree in Engineering.', source='reviewer'):
    job = SimpleNamespace(title=title, company_name='Co', description=description, location='CA', employment_type=None, salary_min=None)
    return {'job': job, 'truth': truth, 'source': source, 'label': None, 'review': {'reason': 'r', 'work': 'w'},
            'cluster': 'HARDWARE / SYSTEMS', 'rules_fit': rules_fit, 'rule_reasons': []}


def evidence_set():
    # The rules pass "Field Service Technician" roles the reviewer keeps rejecting.
    rows = [row(f'Field Service Technician, Site {chr(65 + i)}', False, True) for i in range(8)]
    rows += [row(f'Mechanical Engineer, Team {chr(65 + i)}', True, True) for i in range(14)]
    return rows


def test_due_needs_enough_evidence_disagreement_and_cooldown(dirs):
    tuner = rule_tuner.RuleTuner()
    rows = evidence_set()
    verdicts = [r['rules_fit'] for r in rows]
    assert tuner.due(rows, verdicts, 'mechanical')
    assert not tuner.due(rows[:10], verdicts[:10], 'mechanical')                  # too little evidence
    agreeing = [r for r in rows if r['truth']] * 2
    assert not tuner.due(agreeing, [True] * len(agreeing), 'mechanical')           # no real delta


def proposal_with(extra_off):
    spec = track_specs()['mechanical']
    return {'on_titles': spec['on_titles'], 'off_titles': spec['off_titles'] + extra_off,
            'degree_override': spec['degree_override'], 'rationale': 'technicians are not engineering roles'}


def test_a_proposal_that_matches_the_truth_better_is_applied_and_logged(dirs, monkeypatch):
    applied = []
    tuner = rule_tuner.RuleTuner(apply_changes=lambda: applied.append(True))
    monkeypatch.setattr(rule_tuner, 'propose', lambda text, run: proposal_with([{'label': 'a technician role', 'pattern': r'\btechnician\b'}]))
    rows = evidence_set()
    entry = tuner.tune('mechanical', rows, [r['rules_fit'] for r in rows])
    assert entry['applied'] and entry['after'][0] > entry['before'][0]
    overlay = yaml.safe_load((dirs.config_dir / 'learned_rules.yaml').read_text())
    assert any(o['pattern'] == r'\btechnician\b' for o in overlay['tracks']['mechanical']['off_titles'])
    assert rule_tuner.history()[0]['applied']


def test_a_proposal_that_does_not_help_is_rejected(dirs, monkeypatch):
    tuner = rule_tuner.RuleTuner()
    monkeypatch.setattr(rule_tuner, 'propose', lambda text, run: proposal_with([{'label': 'nothing', 'pattern': r'\bzzzz\b'}]))
    rows = evidence_set()
    entry = tuner.tune('mechanical', rows, [r['rules_fit'] for r in rows])
    assert not entry['applied'] and not (dirs.config_dir / 'learned_rules.yaml').exists()


def test_a_proposal_may_not_get_worse_on_his_own_labels(dirs, monkeypatch):
    tuner = rule_tuner.RuleTuner()
    rows = evidence_set() + [row('Mechanical Engineer, Field Service', True, True, source='his label')]
    monkeypatch.setattr(rule_tuner, 'propose', lambda text, run: proposal_with([{'label': 'field service', 'pattern': r'\bfield\s+service\b'}]))
    entry = tuner.tune('mechanical', rows, [r['rules_fit'] for r in rows])
    # on_titles ("mechanic") keeps his labelled posting in, so this one is allowed; a pattern
    # that also rejected it would lower his-label agreement and be refused.
    assert entry['after'][1] >= entry['before'][1]


def test_patterns_that_match_everything_or_do_not_compile_are_refused():
    with pytest.raises(Exception):
        rule_tuner.validate({'on_titles': ['('], 'off_titles': [{'label': 'x', 'pattern': 'y'}], 'degree_override': []})
    with pytest.raises(ValueError):
        rule_tuner.validate({'on_titles': ['.*'], 'off_titles': [{'label': 'x', 'pattern': 'y'}], 'degree_override': []})


def test_stale_stored_verdicts_cannot_credit_a_noop_proposal(dirs, monkeypatch):
    rows = evidence_set()
    improved = proposal_with([{'label': 'a technician role', 'pattern': r'\btechnician\b'}])
    overlay = {'tracks': {'mechanical': {key: improved[key] for key in tracks.TUNABLE}}}
    (dirs.config_dir / 'learned_rules.yaml').write_text(yaml.safe_dump(overlay))
    before_overlay = (dirs.config_dir / 'learned_rules.yaml').read_text()
    seen_prompts = []
    def unchanged_proposal(text, run):
        seen_prompts.append(text)
        return proposal_with([{'label': 'nothing', 'pattern': r'\bzzzz\b'}])
    monkeypatch.setattr(rule_tuner, 'propose', unchanged_proposal)
    entry = rule_tuner.RuleTuner().tune('mechanical', rows, [r['rules_fit'] for r in rows])
    assert entry['before'] == entry['after'] == (1.0, 1.0)
    assert not entry['applied']
    assert (dirs.config_dir / 'learned_rules.yaml').read_text() == before_overlay
    assert 'Rules disagree with the truth on:\n[]' in seen_prompts[0]

from jobagent.services import unai
from jobagent.services.writing_learner import WritingLearner


def test_tells_names_patterns_and_passes_plain_text():
    text = "This project stands as a testament to my skills, highlighting my commitment to robust design — not only CAD but also testing. Overall, I am passionate."
    kinds = {kind for kind, _ in unai.tells(text)}
    assert {'significance claim', 'tacked-on -ing clause', 'promotional word', 'AI vocabulary', 'negative parallelism', 'em dash', 'summary ending'} <= kinds
    plain = "At Applied Materials I owned a motorized actuator mechanism from concept through prototype. I worked with suppliers to get prototype parts on a strict timeline and budget."
    assert unai.tells(plain) == []


def test_revision_is_kept_only_when_it_is_plainer_and_fits(tmp_path):
    learner = WritingLearner.__new__(WritingLearner)
    drafts = {'Why us?': {'draft': 'I am passionate about robust hardware, not only on a bench.', 'note': 'n'},
              'Project': {'draft': 'I built a camera suite for a robotic test bench.', 'note': 'n'}}
    calls = []

    def revise(prompt, system, schema):
        calls.append(prompt)
        return {'drafts': [{'label': 'Why us?', 'draft': 'I want to build hardware that works in the field.'}, {'label': 'Project', 'draft': 'changed'}]}

    learner._claude = revise
    out = learner.plain({k: dict(v) for k, v in drafts.items()}, {'Why us?': 50})
    assert out['Why us?']['draft'] == 'I want to build hardware that works in the field.' and out['Project'] == drafts['Project']
    assert len(calls) == 1 and 'Project' not in calls[0]
    learner._claude = lambda *a: {'drafts': [{'label': 'Why us?', 'draft': 'I am thrilled, excited to leverage seamless synergy, not just robust.'}]}
    assert learner.plain({k: dict(v) for k, v in drafts.items()})['Why us?'] == drafts['Why us?']
    learner._claude = lambda *a: (_ for _ in ()).throw(RuntimeError('model down'))
    assert learner.plain({k: dict(v) for k, v in drafts.items()}) == drafts

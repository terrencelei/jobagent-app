"""Tests for relevance scoring, career clusters, urgency, and priority."""

import pytest
from jobagent.ranking.career_clusters import CareerClusterEngine
from jobagent.ranking.scorer import RelevanceScorer
from jobagent.ranking.urgency import UrgencyEngine


def test_career_clusters_product_design():
    engine = CareerClusterEngine()
    title = "Apple Product Design Engineer"
    desc = "Design enclosure architecture, plastic injection molding, sheet metal parts using NX and GD&T."
    best_cluster, scores = engine.score_clusters(title, desc)
    assert best_cluster == "PRODUCT / MECHANICAL DESIGN"
    assert scores["PRODUCT / MECHANICAL DESIGN"] > scores["DATA / ENGINEERING ANALYTICS"]


def test_career_clusters_robotics():
    engine = CareerClusterEngine()
    title = "Robotics & Mechatronics Engineer"
    desc = "Program robotic arm motion control, sensor integration, actuator packaging, and ROS nodes."
    best_cluster, scores = engine.score_clusters(title, desc)
    assert best_cluster == "ROBOTICS / MECHATRONICS"


def test_career_clusters_aerospace():
    engine = CareerClusterEngine()
    title = "Structures & Propulsion Hardware Engineer"
    desc = "FEA structural simulation using ANSYS, composite layups, and rocket stage packaging."
    best_cluster, scores = engine.score_clusters(title, desc)
    assert best_cluster == "AEROSPACE / VEHICLE"


def test_relevance_scorer_candidate_boosts():
    scorer = RelevanceScorer()
    # Applied Materials relevant role
    title = "Actuator & Mechanism Development Engineer"
    desc = (
        "Design motorized actuators, semiconductor equipment upgrades, and electromechanical mechanisms. "
        "Experience with SolidWorks, sensors, motors, and automated optimization. Early career / entry level."
    )
    res = scorer.score_job(
        title=title,
        description=desc,
        company_name="Acme Process Tools",
        location="Santa Clara, CA",
    )
    unrelated = scorer.score_job(title, "Prepare invoices and manage customer billing accounts.", "Acme Process Tools", location="Santa Clara, CA")
    assert res["relevance_score"] > unrelated["relevance_score"] + 25
    assert "Acme Process Tools" in str(res["breakdown"]["matching_experience"])
    assert res["priority_score"] > unrelated["priority_score"]


def test_priority_combines_relevance_and_urgency():
    scorer = RelevanceScorer()
    res = scorer.score_job(
        title="Mechanical Engineer, New Grad",
        description="CAD design in SolidWorks with GD&T.",
        company_name="Unlisted Manufacturing Company",
        location="San Mateo, CA",
    )
    # Default priority formula: 0.75 * relevance + 0.25 * urgency
    expected = round((0.75 * res["relevance_score"]) + (0.25 * res["urgency_score"]), 1)
    assert abs(res["priority_score"] - expected) <= 0.2


def test_preferred_qualifications_bonus_and_no_penalty():
    scorer = RelevanceScorer()
    title = "Mechanical Engineer, New Grad"
    desc = (
        "Required Qualifications:\n"
        "- BS in Mechanical Engineering\n"
        "- 0-2 years experience\n"
        "- SolidWorks CAD\n\n"
        "Preferred Qualifications:\n"
        "- 5+ years experience in aerospace structural analysis\n"
        "- Python, GD&T, FEA simulation\n"
    )
    res = scorer.score_job(
        title=title,
        description=desc,
        company_name="SpaceX",
        location="Hawthorne, CA",
    )
    # Preferred 5+ years must NOT incur the experience mismatch penalty
    assert res["breakdown"]["penalties"] == 0.0
    # Preferred qualifications bonus should be awarded for matching candidate skills
    assert res["breakdown"]["preferred_qualifications_bonus"] > 0.0
    assert "GD&T" in res["breakdown"]["matching_preferred_signals"] or "Python" in res["breakdown"]["matching_preferred_signals"]


def test_required_experience_above_three_years_incurs_penalty():
    scorer = RelevanceScorer()
    title = "Hardware Design Engineer"
    desc = "Requirements: BS in Engineering. Minimum 5+ years of experience in hardware design."
    res = scorer.score_job(
        title=title,
        description=desc,
        company_name="Verkada",
        location="San Mateo, CA",
    )
    assert res["breakdown"]["penalties"] >= 35.0



def test_title_alone_does_not_override_description_fit():
    scorer = RelevanceScorer()
    good = scorer.score_job("Mechanical Engineer", "Design mechanical actuators and aerospace hardware with SolidWorks and GD&T. Develop robotics, motor controls, sensors, and manufacturing automation.", "Example")
    weak = scorer.score_job("Mechanical Engineer", "Manage customer accounts, prepare sales contracts, and handle billing inquiries.", "Example")
    assert good['relevance_score'] > weak['relevance_score'] + 25
    assert weak['breakdown']['semantic_role_match'] <= 5


def test_preferred_skills_do_not_inflate_core_fit():
    scorer = RelevanceScorer()
    core = "Required Qualifications:\nBS in mechanical engineering. SolidWorks."
    baseline = scorer.score_job("Engineer", core, "Example")
    extra = scorer.score_job("Engineer", core + "\nPreferred Qualifications:\nPython, MATLAB, sensors, actuators, robotics, GD&T.", "Example")
    for field in ('technical_skill_match','experience_match','semantic_role_match','industry_match'):
        assert baseline['breakdown'][field] == extra['breakdown'][field]
    assert extra['breakdown']['preferred_qualifications_bonus'] > 0


def test_keyword_rich_but_ineligible_role_has_low_fit():
    scorer = RelevanceScorer()
    result = scorer.score_job("Mechanical Engineer New Grad", "Required: Master's degree in Mechanical Engineering. SolidWorks, Python, MATLAB, GD&T, robotics, actuators, sensors, aerospace, semiconductor and mechanical design.", "Acme Process Tools")
    assert result['relevance_score'] <= 25
    assert 'INELIGIBLE' in result['breakdown']['explanation']


def test_summary_only_posting_is_not_a_high_fit():
    result = RelevanceScorer().score_job("Mechanical Engineer New Grad", "Target Degree Level: Bachelor's\nSource: Early-Career & New Grad Network", "SpaceX")
    assert result['relevance_score'] <= 25
    assert 'UNCERTAIN' in result['breakdown']['explanation']


def test_company_preference_ranks_by_sector():
    """Tech and robotics outrank defense, aerospace and automotive, and the rest sit between."""
    from jobagent.config import load_ranking_config
    from jobagent.ranking.scorer import RelevanceScorer

    ranking = load_ranking_config()
    pref = ranking.company_preference
    sectors = pref["sectors"]
    tech = sectors["tech_and_robotics"]["points"]
    defense = sectors["defense_aerospace_automotive"]["points"]
    assert tech > pref["default_points"] > defense

    def score(company):
        comp = company.lower()
        out, best = float(pref["default_points"]), ""
        for sector in sectors.values():
            for name in sector["companies"]:
                if name in comp and len(name) > len(best):
                    best, out = name, float(sector["points"])
        return out

    assert score("Figure AI") == tech
    assert score("Boston Dynamics") == tech
    assert score("Anduril") == defense
    assert score("SpaceX") == defense
    assert score("Some Unlisted Startup") == float(pref["default_points"])


def test_priority_prefers_qualified_consumer_and_robotics_roles():
    scorer = RelevanceScorer()
    description = 'Bachelor degree in Mechanical Engineering. Entry level. Design mechanical prototypes using SolidWorks CAD and test motors and actuators. Start July 2027.'
    for company in ['Apple', 'Meta Platforms', 'Dyna Robotics', 'Sunday', 'Collaborative Robotics']:
        result = scorer.score_job('Mechanical Engineer, New Grad', description, company, 'Sunnyvale, CA')
        base = .75 * result['relevance_score'] + .25 * result['urgency_score']
        assert result['priority_score'] == round(min(100, base + 12), 1)
        assert 'Priority preference: +12' in result['breakdown']['explanation']
    unrelated = scorer.score_job('Mechanical Engineer, New Grad', description, 'Metallix Manufacturing', 'Sunnyvale, CA')
    assert unrelated['priority_score'] == round(.75 * unrelated['relevance_score'] + .25 * unrelated['urgency_score'], 1)
    unqualified = scorer.score_job('Mechanical Engineer', 'Requires a PhD in Mechanical Engineering and 10 years of experience.', 'Apple', 'Sunnyvale, CA')
    assert 'Priority preference:' not in unqualified['breakdown']['explanation']
    below_salary = scorer.score_job('Mechanical Engineer, New Grad', description, 'Apple', 'Sunnyvale, CA', salary_min=90000)
    assert 'Priority preference:' not in below_salary['breakdown']['explanation']


@pytest.mark.parametrize('requirement,years', [("over 4 years' working experience",4),
    ('3+ years of consumer product design',3)])
def test_big_tech_priority_does_not_hide_required_experience(requirement, years):
    result = RelevanceScorer().score_job('Mechanical Solution Engineer, Robotics',
        'Minimum requirements: Bachelor degree in Mechanical Engineering with ' + requirement,
        'NVIDIA', 'Santa Clara, CA')
    assert result['experience_required_years'] == years
    assert 'Priority preference:' not in result['breakdown']['explanation']


def test_shared_experience_after_degree_list_and_technical_leader():
    from jobagent.processing.qualifications import required_experience_years, is_early_career, SENIOR_PATTERN
    import re
    assert required_experience_years('BS, MS, or PhD in Mechanical Engineering + 10 years’ experience.') == 10
    assert re.search(SENIOR_PATTERN, 'Hardware Engineering Technical Leader')
    assert not is_early_career('Engineer I Technical Leader')


def test_priority_adds_points_for_product_design_titles():
    scorer = RelevanceScorer()
    description = 'Bachelor degree in Mechanical Engineering. Entry level. Design mechanical prototypes using SolidWorks CAD and test motors and actuators. Start July 2027.'
    base = lambda r: .75 * r['relevance_score'] + .25 * r['urgency_score']
    both = scorer.score_job('Product Design Engineer, New Grad', description, 'Apple', 'Sunnyvale, CA')
    assert both['priority_score'] == round(min(100, base(both) + 27), 1)
    assert 'your top role' in both['breakdown']['explanation']
    title_only = scorer.score_job('Product Design Engineer, New Grad', description, 'Metallix Manufacturing', 'Sunnyvale, CA')
    assert title_only['priority_score'] == round(min(100, base(title_only) + 15), 1)
    designer = scorer.score_job('Product Designer', description, 'Metallix Manufacturing', 'Sunnyvale, CA')
    assert 'your top role' not in designer['breakdown']['explanation']

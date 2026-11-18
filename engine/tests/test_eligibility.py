"""Tests for Eligibility Engine and nuanced start-date reasoning."""

import pytest
from jobagent.db.models import EligibilityStatus
from jobagent.processing.eligibility import EligibilityEngine


@pytest.fixture
def engine():
    return EligibilityEngine()


def test_posting_with_no_specified_start_date_remains_eligible(engine):
    """
    CRITICAL TEST REQUIREMENT:
    A full-time role posted September 2026 with NO specified start date must remain eligible.
    Unknown start date must NEVER be interpreted as incompatible.
    """
    title = "Mechanical Design Engineer"
    desc = (
        "We are looking for a Mechanical Design Engineer to design structural enclosures, "
        "actuator mounts, and thermal hardware. Requirements: BS in Mechanical Engineering "
        "or related field. Proficiency in SolidWorks, GD&T, and tolerance analysis. 0-2 years experience."
    )
    status, reasons, stated_start_date, has_conflict = engine.evaluate(title, desc)

    assert has_conflict is False
    assert stated_start_date is None
    # Must remain fully eligible (ELIGIBLE or STRONG_MATCH or LIKELY_ELIGIBLE), NOT INELIGIBLE or CONFLICT
    assert status in (EligibilityStatus.ELIGIBLE, EligibilityStatus.STRONG_MATCH, EligibilityStatus.LIKELY_ELIGIBLE)
    assert any("Start date not explicitly specified: treated as neutral" in r for r in reasons)


def test_2027_new_grad_receives_strong_match(engine):
    """
    CRITICAL TEST REQUIREMENT:
    A '2027 New Grad' role must receive strong early-career fit.
    """
    title = "Hardware Engineer (2027 New Grad)"
    desc = (
        "Join our team as an early career Hardware Engineer starting Summer 2027. "
        "Eligible candidates are graduating between December 2026 and June 2027. "
        "BS in Mechanical Engineering, Mechatronics, or Electrical Engineering required."
    )
    status, reasons, stated_start_date, has_conflict = engine.evaluate(title, desc)

    assert has_conflict is False
    assert status == EligibilityStatus.STRONG_MATCH
    assert stated_start_date is not None
    assert any("Target graduation/start match" in r for r in reasons)


def test_explicit_early_start_generates_conflict(engine):
    """
    CRITICAL TEST REQUIREMENT:
    A posting explicitly requiring January 2027 start should generate a start-date conflict.
    """
    title = "Mechanical Engineer"
    desc = (
        "We need an engineer to support our immediate assembly ramp. "
        "Start date: January 2027. Must begin January 2027 on site in Austin, TX. "
        "BS in Mechanical Engineering required."
    )
    status, reasons, stated_start_date, has_conflict = engine.evaluate(title, desc)

    assert has_conflict is True
    assert status == EligibilityStatus.INELIGIBLE
    assert any("Start date conflict" in r for r in reasons)
    assert any("while candidate becomes available Summer 2027" in r for r in reasons)


def test_senior_and_high_experience_penalized(engine):
    title = "Principal Staff Mechanical Engineer"
    desc = "Lead architectural decisions. Minimum 8+ years of industry experience required."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status in (EligibilityStatus.LIKELY_INELIGIBLE, EligibilityStatus.INELIGIBLE)


def test_phd_only_requirement_ineligible(engine):
    title = "Research Scientist - Dynamics"
    desc = "Ph.D. required in Computational Mechanics. Postdoctoral experience preferred."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.INELIGIBLE


def test_school_year_internship_conflict(engine):
    """Candidate is taking classes during the academic year until June 2027 graduation."""
    title = "Mechanical Engineering Intern (Spring 2027)"
    desc = "Join our mechanical design team for Spring 2027 internship. 40 hours per week."
    status, reasons, stated_date, has_conflict = engine.evaluate(title, desc)
    assert has_conflict is True
    # Internships are filtered from the queue by role_type, not ruled out by eligibility,
    # so they stay viewable. The schedule clash is what classifies this one.
    assert status == EligibilityStatus.INELIGIBLE
    assert engine.classify_role_type(title) == "INTERNSHIP"
    assert any("Availability conflict" in r for r in reasons)
    assert not any("Role type mismatch" in r for r in reasons)


def test_summer_internship_is_marked_internship_not_hidden(engine):
    """A Summer 2027 internship matches the season, so only role_type keeps it out of the queue."""
    title = "Aircraft Mechanical Integration Intern (Summer 2027)"
    desc = "Summer 2027 internship building aircraft integration tooling."
    status, reasons, _, _ = engine.evaluate(title, desc)
    # Still viewable on the internships tab rather than discarded.
    assert engine.classify_role_type(title) == "INTERNSHIP"
    assert status != EligibilityStatus.INELIGIBLE
    assert not any("Role type mismatch" in r for r in reasons)


def test_full_time_role_is_classified_full_time(engine):
    assert engine.classify_role_type("New Graduate Engineer, Mechanical") == "FULL_TIME"


def test_exactly_three_required_years_is_filtered(engine):
    """Policy is three or more required years, so three itself must not pass."""
    title = "Mechanical Engineer"
    desc = "Requirements: BS in Mechanical Engineering. 3+ years of experience required."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("policy excludes 3 or more required years" in r for r in reasons)


def test_two_required_years_without_evidence_is_not_selected(engine):
    """Two years of required experience is a stretch for a new graduate, not a clean match."""
    title = "Hardware Test Engineer I"
    desc = "BSME required. 2+ years of hands-on hardware experience building and testing systems."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("Not selected" in r for r in reasons)


def test_outside_us_location_ineligible(engine):
    """Candidate is seeking US-based roles; international locations must be flagged."""
    title = "Mechanical Design Engineer"
    desc = "Design enclosures and mechanisms. BS in Mechanical Engineering required."
    status, reasons, _, _ = engine.evaluate(title, desc, location="London, UK")
    assert status == EligibilityStatus.INELIGIBLE
    assert any("outside the United States" in r for r in reasons)


def test_salary_below_threshold_flagged(engine):
    """Salary below $90,000 threshold must be flagged."""
    title = "Junior Mechanical Engineer"
    desc = "CAD modeling and drafting. BS required."
    status, reasons, _, _ = engine.evaluate(title, desc, salary_min=65000)
    assert any("Salary below policy threshold" in r for r in reasons)


def test_high_years_of_experience_classified_likely_ineligible(engine):
    """Roles requiring 5+ years of experience are likely ineligible for a new grad."""
    title = "Mechanical Systems Engineer"
    desc = "Requires 5+ years of professional engineering experience. BS in Mechanical Engineering."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("High experience threshold" in r for r in reasons)


def test_preferred_qualifications_do_not_disqualify(engine):
    """
    CRITICAL POLICY REQUIREMENT:
    Preferred qualifications (e.g. Master's/PhD preferred, 5+ years preferred) must NEVER
    disqualify an otherwise eligible posting.
    """
    title = "Mechanical Design Engineer"
    desc = (
        "We are looking for a Mechanical Design Engineer.\n"
        "Required Qualifications:\n"
        "- Bachelor's degree in Mechanical Engineering, Robotics, or related discipline.\n"
        "- 1+ years experience in CAD and mechanical design.\n\n"
        "Preferred Qualifications:\n"
        "- Master's degree or Ph.D. in Mechanical Engineering.\n"
        "- 5+ years experience in precision mechanism design and FEA.\n"
        "- Experience with AS9100 or aerospace manufacturing standards.\n"
    )
    status, reasons, stated_start, has_conflict = engine.evaluate(title, desc)
    assert status in (EligibilityStatus.ELIGIBLE, EligibilityStatus.STRONG_MATCH, EligibilityStatus.LIKELY_ELIGIBLE)
    assert status not in (EligibilityStatus.INELIGIBLE, EligibilityStatus.LIKELY_INELIGIBLE)
    assert not has_conflict
    assert any("Degree requirement matched" in r for r in reasons)
    assert any("Preferred qualifications noted" in r for r in reasons)


def test_four_years_required_experience_is_ineligible(engine):
    """Roles requiring > 3 years of experience in required qualifications violate candidate policy."""
    title = "Mechanical Integration Engineer"
    desc = "Requirements: BS in Mechanical Engineering. 4+ years of experience in hardware integration."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("policy excludes 3 or more required years" in r for r in reasons)


def test_masters_strictly_required_is_ineligible(engine):
    """Roles strictly requiring a Master's degree (no Bachelor's accepted) are ineligible."""
    title = "Finite Element Analysis Specialist"
    desc = "Requirements: Master's degree required in Mechanical Engineering or Structural Mechanics."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.INELIGIBLE
    assert any("Position strictly requires a Master's degree" in r for r in reasons)


def test_irrelevant_non_stem_degree_is_ineligible(engine):
    """Roles requiring a degree in an unrelated non-STEM discipline are ineligible."""
    title = "Staff Recruiter"
    desc = "Requirements: Bachelor's degree in Human Resources or Communications required. 1-2 years experience."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.INELIGIBLE
    assert any("Ineligible degree discipline" in r for r in reasons)


def test_receipt_matching_rejects_near_identical_but_different_postings():
    """A receipt must never retire a posting it does not actually name."""
    from jobagent.tracking.email_reconcile import Receipt, match_receipt

    class _J:
        def __init__(self, i, c, t):
            self.id, self.company_name, self.title = i, c, t

    jobs = [
        _J(1, "Anduril", "2026 Early Career Mechanical Engineer"),
        _J(2, "Rocket Lab", "Mechanical Test Engineer II"),
        _J(3, "Freeform", "Electrical Engineer New Grad - Summer 2027"),
        _J(4, "SpaceX", "New Graduate Engineer, Starship Components"),
    ]
    # Wrong year, wrong level, wrong discipline: each must be refused.
    assert match_receipt(Receipt("Anduril", "2027 Early Career Mechanical Engineer"), jobs)[0] is None
    assert match_receipt(Receipt("Rocket Lab", "Mechanical Test Engineer I"), jobs)[0] is None
    assert match_receipt(Receipt("Freeform", "Mechanical Engineer (New Grad Summer 2027)"), jobs)[0] is None
    # The posting the receipt really names still matches.
    job, score = match_receipt(Receipt("SpaceX", "New Graduate Engineer, Starship Components"), jobs)
    assert job is not None and job.id == 4 and score == 1.0


def test_december_2026_graduate_intake_conflicts(engine):
    """Graduating June 2027 rules out a December 2026 new-graduate cohort."""
    title = "December 2026 New Graduate Engineer, Mechanical"
    desc = "Join our mechanical team. BS in Mechanical Engineering."
    status, reasons, _, has_conflict = engine.evaluate(title, desc)
    assert has_conflict is True
    assert status == EligibilityStatus.INELIGIBLE


def test_fixed_term_associate_role_is_an_internship(engine):
    """A twelve-week "Associate" post is an internship however it is titled."""
    title = "Environmental Test Engineer Associate (Winter 2027)"
    desc = ("&lt;p&gt;Associate Engineer positions typically last for twelve weeks, and are "
            "salaried roles designed for students.&lt;/p&gt;")
    assert engine.classify_role_type(title, desc) == "INTERNSHIP"
    assert engine.classify_role_type("New Graduate Engineer, Mechanical", "Full-time permanent role.") == "FULL_TIME"


def test_years_without_a_plus_sign_still_counts(engine):
    """"7 years of relevant experience" states a bar as plainly as "7+ years"."""
    title = "Stress Analysis Engineer, Maritime Structures"
    desc = "Requirements: Bachelor's degree in Mechanical Engineering. 7 years of relevant experience in structural analysis."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("7+ years" in r for r in reasons)


def test_lowest_stated_bar_is_the_one_that_counts(engine):
    """When a posting lists Mid and Senior bars, the lower one is what a candidate must clear."""
    title = "Structures Engineer"
    desc = "Requirements: BS in Mechanical Engineering. 4+ years (Mid) or 7+ years (Senior) of demonstrated experience."
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("4+ years" in r for r in reasons)


def test_company_blurb_years_do_not_mask_a_real_requirement(engine):
    """"over 100-years of combined experience" must not be read as a zero-year bar."""
    title = "Manufacturing Test Engineer"
    desc = ("Anduril is a venture-backed team with over 100-years of combined AUV experience. "
            "Requirements: Bachelor's degree in Mechanical Engineering. "
            "3+ years of experience in a relevant field.")
    status, reasons, _, _ = engine.evaluate(title, desc)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("3+ years" in r for r in reasons)


def test_prior_year_cohort_conflicts(engine):
    """A 2026 early-career intake is the wrong cohort for a June 2027 graduate."""
    status, reasons, _, conflict = engine.evaluate(
        "2026 Early Career Flight Test Engineer, Mission Autonomy",
        "Work on test and evaluation programs. Bachelor's degree in engineering.")
    assert conflict is True
    assert status == EligibilityStatus.INELIGIBLE


def test_years_stated_without_the_word_experience(engine):
    """"5+ years designing mechanical systems" is a requirement even with no such word."""
    status, reasons, _, _ = engine.evaluate(
        "New Products Mechanical Design Engineer",
        "Requirements: Required: 5+ years designing mechanical systems for aerospace, robotics, automotive.")
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("5+ years" in r for r in reasons)


def test_2026_graduate_title_conflicts(engine):
    """"Engineer I - 2026 Graduate" is the prior year's intake."""
    status, _, _, conflict = engine.evaluate(
        "Vehicle Structures Engineer I - 2026 Graduate",
        "Design vehicle structures. Bachelor's degree in mechanical or aerospace engineering.")
    assert conflict is True
    assert status == EligibilityStatus.INELIGIBLE


@pytest.mark.parametrize('title,description,expected', [
    ('Mechanical Engineer', 'Required: BS in Mechanical Engineering.\n5 years designing hardware.\n1 year using Python.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer', 'Required: BS in Mechanical Engineering and 5 years experience or MS and 2 years experience.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer', 'Requirements: BS in Mechanical Engineering.\nThree (3) years of experience.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer', 'Requirements: BS in Mechanical Engineering.\nPreferred Qualifications:\n5 years experience.\nRequired Qualifications:\n4 years building hardware.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer', 'Requirements: BS in Mechanical Engineering. 5 years experience preferred.', EligibilityStatus.ELIGIBLE),
    ('Mechanical Engineer', '<h3>Required Qualifications</h3><p>BS in Mechanical Engineering.</p><h3>Preferred Qualifications</h3><p>MS and 5 years experience.</p>', EligibilityStatus.ELIGIBLE),
    ('New Grad Engineer 2027', 'Required: BS in Mechanical Engineering.\n2 years of experience.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Sr. Mechanical Engineer', 'BS in Mechanical Engineering.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer III', 'BS in Mechanical Engineering.', EligibilityStatus.LIKELY_INELIGIBLE),
    ('Mechanical Engineer', 'We build aerospace hardware. Requirements: Bachelor\'s degree in Marketing.', EligibilityStatus.INELIGIBLE),
    ('Computer Engineer', 'Required: BS in Computer Science.', EligibilityStatus.INELIGIBLE),
    ('Computer Engineer', 'Required: BS in Computer Science or a related engineering field.', EligibilityStatus.ELIGIBLE),
    ('Mechanical Engineer', 'Required Qualifications:\nMaster’s degree in Mechanical Engineering.', EligibilityStatus.INELIGIBLE),
    ('Mechanical Engineer', 'Required Qualifications:\nPh.D. in Mechanical Engineering.', EligibilityStatus.INELIGIBLE),
    ('Mechanical Engineer I', 'Degree in mechanical engineering completed or expected by June 2026.', EligibilityStatus.INELIGIBLE),
])
def test_qualification_regressions(engine,title,description,expected):
    assert engine.evaluate(title,description)[0]==expected


def test_remote_canada_is_not_us(engine):
    assert engine.evaluate('Mechanical Engineer','BS in Mechanical Engineering.',location='Remote, Canada')[0]==EligibilityStatus.INELIGIBLE


def test_role_classification_uses_employment_type_and_avoids_incidental_duration(engine):
    assert engine.classify_role_type('Mechanical Engineer','Full-time role. Projects last twelve weeks.')=='FULL_TIME'
    assert engine.classify_role_type('Mechanical Engineer','', 'Intern')=='INTERNSHIP'
    assert engine.classify_role_type('Mechanical Engineer','', 'Contract')=='OTHER'


def test_years_gate_obeys_config(engine):
    engine.profile.candidate['max_required_experience_years']=5
    status,reasons,_,_=engine.evaluate('Mechanical Engineer','BS in Mechanical Engineering. 4 years of experience.')
    assert status==EligibilityStatus.LIKELY_INELIGIBLE


def test_related_field_does_not_make_accounting_an_engineering_degree(engine):
    result, reasons, *_ = engine.evaluate(
        "Mechanical Engineer", "Required: Bachelor's degree in Accounting or a related field.",
        "California, USA", "Full-time", None)
    assert result == EligibilityStatus.INELIGIBLE
    assert any("discipline" in reason for reason in reasons)


def test_stub_degree_alone_does_not_establish_eligibility(engine):
    """Aggregator stubs carry no body, but the degree level they state is usable signal."""
    stub = ("Position: Early Career Electrical Engineer\nCompany: Acme\n"
            "Category: Hardware\nLocations: Austin, TX\nTarget Degree Level: Bachelor's\n"
            "Source: Early-Career & New Grad Network")
    status, reasons, _, _ = engine.evaluate("Early Career Mechanical Engineer", stub)
    assert status == EligibilityStatus.UNCERTAIN
    assert any("not yet verified" in r.lower() for r in reasons)


def test_stub_listing_targeting_a_doctorate_is_ineligible(engine):
    stub = ("Position: Research Scientist\nCompany: Acme\nCategory: AI/ML\n"
            "Locations: Santa Clara, CA\nTarget Degree Level: PhD\n"
            "Source: Early-Career & New Grad Network")
    status, reasons, _, _ = engine.evaluate("Research Scientist", stub)
    assert status == EligibilityStatus.INELIGIBLE
    # Caught by the degree rule before the stub branch is reached; either path is correct.
    assert any("phd" in r.lower() or "no bachelor" in r.lower() for r in reasons)


@pytest.mark.parametrize("text, years", [
    ("Bachelor's degree in engineering OR 2+ years of professional experience.", None),
    ("Bachelor's degree in engineering\nOR 2+ years of experience in lieu of a degree.\n1+ years of experience with Python.", 1),
    ("2+ years of experience in a technician role, or a degree in engineering.", None),
    ("2 years or less of experience in manufacturing engineering.", 0),
    ("5+ years of progressively complex operations and US Government or Military program management experience, with at least 2 years in a managerial capacity.", 5),
    ("PhD with 2 years of experience or MS with 4 years of experience or BS with 8 years of experience.", 8),
    ("BS in engineering and 2 years of experience.", 2),
    ("BS and 5 years of experience OR MS and 2 years of experience.", 5),
])
def test_review_learned_experience_rules(text, years):
    from jobagent.processing.qualifications import required_experience_years
    assert required_experience_years(text) == years


def test_mixed_graduation_cohort_accepts_2027_without_ignoring_deadlines(engine):
    description = "Required: Bachelor's degree in engineering. Graduating in the class of 2026 or 2027."
    status, _, _, conflict = engine.evaluate("New Graduate Engineer", description)
    assert status == EligibilityStatus.STRONG_MATCH
    assert not conflict
    status, _, _, conflict = engine.evaluate("New Graduate Engineer", description + "\nDegree completed by December 2026.")
    assert status == EligibilityStatus.INELIGIBLE
    assert conflict


def test_experience_evidence_does_not_double_count_or_project_future_time(engine):
    from datetime import date
    from jobagent.processing.qualifications import documented_experience_years
    assert documented_experience_years(engine.profile, date(2026, 9, 19)) < 2


@pytest.mark.parametrize("requirement", [
    "Experience in full stack development.",
    "Experience designing and implementing security solutions for operating systems.",
])
def test_specialist_requirements_need_documented_background(engine, requirement):
    status, reasons, *_ = engine.evaluate("Mechanical Engineer", "Required: BS in engineering.\n" + requirement)
    assert status == EligibilityStatus.LIKELY_INELIGIBLE
    assert any("not documented" in r for r in reasons)
    status, *_ = engine.evaluate("Mechanical Engineer", "Required: BS in engineering.\nPreferred qualifications:\n" + requirement)
    assert status == EligibilityStatus.ELIGIBLE


def test_cohort_year_is_not_a_degree_field():
    """"PhD in 2027" states when the candidate graduates, not what the degree is in."""
    from jobagent.processing.qualifications import degree_requirements
    fields = ["mechanical engineering", "statistics and data science", "engineering"]
    text = ("Graduating with a bachelor's degree, master's degree or PhD in 2027\n"
            "Degree in an engineering discipline or physics")
    relevant, unrelated, masters, phd = degree_requirements(text, fields)
    assert relevant is True
    assert unrelated is False
    assert masters is False and phd is False


def test_engineering_at_large_accepts_a_generic_engineering_degree():
    from jobagent.processing.qualifications import degree_requirements
    fields = ["mechanical engineering", "engineering"]
    for text in ["Bachelor's degree in an engineering discipline or physics",
                 "Bachelor's degree in any engineering field",
                 "BS in an engineering major"]:
        relevant, unrelated, _, _ = degree_requirements(text, fields)
        assert relevant is True, text
        assert unrelated is False, text


def test_an_unrelated_discipline_is_still_rejected():
    from jobagent.processing.qualifications import degree_requirements
    relevant, unrelated, _, _ = degree_requirements(
        "Bachelor's degree in nursing or education", ["mechanical engineering", "engineering"])
    assert relevant is False
    assert unrelated is True


@pytest.mark.parametrize("title", ["2027 Early Career Electrical Engineer", "Software Engineer - New Grad",
                                   "Associate Systems Administrator", "Product Designer, New Grad",
                                   "New Graduate Engineer, Silicon Engineering", "Genesis Program - Sales Orchestrator 1"])
def test_another_disciplines_title_is_ineligible_however_junior(engine, title):
    status, reasons, *_ = engine.evaluate(title, "Required: Bachelor's degree in engineering. Summer 2027 start.")
    assert status == EligibilityStatus.INELIGIBLE
    assert any("Discipline mismatch" in r for r in reasons)


@pytest.mark.parametrize("title", ["Mechanical Engineer I", "Electromechanical Engineer, New Grad", "Electrical & Mechanical Test Engineer",
                                   "Mechanical Product Design Engineer I"])
def test_his_disciplines_keep_their_label(engine, title):
    status, reasons, *_ = engine.evaluate(title, "Required: Bachelor's degree in engineering.")
    assert not any("Discipline mismatch" in r for r in reasons)


def test_degree_or_equivalent_in_another_field_is_unrelated():
    from jobagent.processing.qualifications import degree_requirements
    text = "Bachelor's degree (or equivalent) in a relevant field (Computer Science, EECS, Computer Engineering)"
    assert degree_requirements(text, ["mechanical", "engineering", "statistics"])[1]


def test_no_discipline_signal_is_other():
    from jobagent.ranking.career_clusters import CareerClusterEngine
    best, _ = CareerClusterEngine().score_clusters("Associate Systems Administrator", "Maintain servers and user accounts.")
    assert best == "OTHER"


@pytest.mark.parametrize("desc", ["Required: Bachelor's degree in Electrical or Mechanical Engineering.",
                                  "Required: BS in Electrical Engineering.\nPreferred qualifications:\nMS in Mechanical Engineering."])
def test_a_title_from_another_discipline_is_his_when_degrees_name_mechanical(engine, desc):
    status, reasons, *_ = engine.evaluate("Power Systems Engineer I", desc)
    assert not any("Discipline mismatch" in r for r in reasons)


def test_mechanical_outside_a_degree_line_does_not_rescue_the_title(engine):
    status, reasons, *_ = engine.evaluate("Electrical Engineer I", "Required: BS in Electrical Engineering.\nWork with mechanical assemblies.")
    assert status == EligibilityStatus.INELIGIBLE



def data_engine():
    from jobagent.processing.tracks import get_track
    return EligibilityEngine(track=get_track('data'))


@pytest.mark.parametrize("title", ["Data Scientist, New Grad", "Data Analyst I", "Machine Learning Engineer - New Grad",
                                   "Associate Statistician", "Analytics Engineer, Early Career"])
def test_data_track_takes_data_titles(title):
    status, reasons, *_ = data_engine().evaluate(title, "Required: Bachelor's degree in Statistics, Mathematics or a related field.")
    assert not any("Discipline mismatch" in r for r in reasons)


@pytest.mark.parametrize("title", ["Mechanical Engineer I", "Associate Test Engineer", "Software Engineer - New Grad", "Electrical Engineer"])
def test_data_track_leaves_engineering_roles_to_the_other_track(title):
    status, reasons, *_ = data_engine().evaluate(title, "Required: Bachelor's degree in Engineering.")
    assert status == EligibilityStatus.INELIGIBLE and any("Discipline mismatch" in r for r in reasons)


def test_data_track_title_is_rescued_by_a_statistics_degree_line():
    status, reasons, *_ = data_engine().evaluate("Associate Engineer, Reliability", "Required: BS in Statistics or Data Science.")
    assert not any("Discipline mismatch" in r for r in reasons)


def test_mechanical_track_leaves_data_roles_to_the_other_track(engine):
    status, reasons, *_ = engine.evaluate("Data Scientist, New Grad", "Required: Bachelor's degree in Engineering.")
    assert status == EligibilityStatus.INELIGIBLE


def test_each_track_files_postings_under_its_own_disciplines():
    from jobagent.processing.tracks import get_track
    from jobagent.ranking.scorer import RelevanceScorer
    desc = "Build predictive models and dashboards with SQL and Python; A/B test analysis; regression and forecasting."
    data = RelevanceScorer(track=get_track('data')).score_job("Data Scientist, New Grad", desc, "Acme")
    mech = RelevanceScorer(track=get_track('mechanical')).score_job("Data Scientist, New Grad", desc, "Acme")
    assert data["best_career_cluster"] in get_track('data').clusters
    assert data["relevance_score"] > mech["relevance_score"]


@pytest.mark.parametrize("desc,expected", [
    ("Requirements:\n2+ years of experience in mechanical design.\nPreferred Qualifications:\n5+ years of experience with SolidWorks.", (2, 5)),
    ("Bachelor's degree and 0-2 years of experience. 3+ years of relevant experience is a plus.", (0, 3)),
    ("Design mechanisms for consumer products.", (None, None)),
])
def test_required_and_preferred_years_are_read(desc, expected):
    from jobagent.processing.qualifications import experience_years
    assert experience_years(desc) == expected


def test_experience_years_shape_fit():
    from jobagent.ranking.scorer import RelevanceScorer
    scorer = RelevanceScorer()
    base = "Design mechanical assemblies in SolidWorks for robotics hardware. Required: BS in Mechanical Engineering."
    fit = lambda extra: scorer.score_job("Mechanical Engineer I", base + "\n" + extra, "Acme")
    none, zero, two, pref = (fit(""), fit("0-2 years of experience."), fit("2+ years of experience required."),
                             fit("Preferred qualifications:\n5+ years of experience with CAD."))
    assert zero["relevance_score"] > none["relevance_score"] > two["relevance_score"]
    assert pref["relevance_score"] < none["relevance_score"]
    assert (two["experience_required_years"], pref["experience_preferred_years"]) == (2, 5)
    assert "yrs preferred" in pref["breakdown"]["explanation"]


def test_bangkok_role_is_outside_us(engine):
    status, reasons, _, _ = engine.evaluate('Alignment Process Engineer',
        'Requirements: BS Mechanical Engineering. 1 year experience.',location='Bangkok, Thailand')
    assert status == EligibilityStatus.INELIGIBLE
    assert any('outside the United States' in r for r in reasons)

from jobagent.processing.qualifications import degree_requirements

FIELDS = ['mechanical engineering', 'engineering']


def test_undergraduate_or_graduate_internship_does_not_require_masters_from_cohort_list():
    text = ("Must be currently enrolled in an undergraduate or graduate degree program in Mechanical Engineering, Automotive Engineering, Mechatronics, or a related engineering field.\n"
            "Students entering their Junior, Senior, or Master's program at the start of the upcoming academic term.")
    relevant, unrelated, masters, phd = degree_requirements(text, FIELDS)
    assert relevant and not unrelated and not masters and not phd


def test_separate_mandatory_masters_is_not_cleared_by_a_student_cohort_alternative():
    text = "Students entering their Junior, Senior, or Master's program.\nA Master's degree in Mechanical Engineering is required."
    assert degree_requirements(text, FIELDS)[2]


def test_senior_title_and_undergraduate_prerequisite_do_not_override_graduate_requirement():
    for text in ["Senior engineer: Master's degree in Mechanical Engineering required.",
                 "A Bachelor's degree in Mechanical Engineering is required.\nMust be enrolled in a Master's program.",
                 "Junior or senior students must be enrolled in a Master's degree in Mechanical Engineering."]:
        assert degree_requirements(text, FIELDS)[2]


def test_enrollment_degree_program_still_requires_a_relevant_field():
    assert degree_requirements('Enrolled in a degree program in Mechanical Engineering.', FIELDS)[0]
    relevant, unrelated, _, _ = degree_requirements('Enrolled in a degree program in Nursing.', FIELDS)
    assert not relevant and unrelated

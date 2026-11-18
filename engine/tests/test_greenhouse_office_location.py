from jobagent.scrapers.greenhouse import office_location

SAN_MATEO = {'name': 'San Mateo ', 'location': 'San Mateo, California, United States'}


def test_a_bare_city_takes_its_matching_offices_full_location():
    assert office_location('San Mateo', [SAN_MATEO]) == 'San Mateo, California, United States'
    assert office_location('San Mateo ', [{'name': 'India', 'location': 'Bengaluru, Karnataka, India'}, SAN_MATEO]) == 'San Mateo, California, United States'


def test_a_confirmed_or_unmatched_location_is_kept():
    assert office_location('San Mateo, CA', [SAN_MATEO]) == 'San Mateo, CA'
    assert office_location('San Mateo', [{'name': 'Pittsburgh', 'location': None}]) == 'San Mateo'
    assert office_location('Remote', [SAN_MATEO]) == 'Remote'

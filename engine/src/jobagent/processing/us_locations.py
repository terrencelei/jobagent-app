"""U.S.-only admission policy: require evidence in the job's location, never its prose.

Remote, missing and unrecognized locations are held out of the database until a source
provides a U.S. location. Employer headquarters and candidate authorization prove nothing
about the location of a particular vacancy.
"""
import re

# Full names kept explicit so multiword states are not split into unrelated tokens.
STATE_NAMES = ('Alabama|Alaska|Arizona|Arkansas|California|Colorado|Connecticut|Delaware|'
               'Florida|Georgia|Hawaii|Idaho|Illinois|Indiana|Iowa|Kansas|Kentucky|Louisiana|'
               'Maine|Maryland|Massachusetts|Michigan|Minnesota|Mississippi|Missouri|Montana|'
               'Nebraska|Nevada|New Hampshire|New Jersey|New Mexico|New York|North Carolina|'
               'North Dakota|Ohio|Oklahoma|Oregon|Pennsylvania|Rhode Island|South Carolina|'
               'South Dakota|Tennessee|Texas|Utah|Vermont|Virginia|Washington|West Virginia|'
               'Wisconsin|Wyoming|District of Columbia')
STATE_CODES = ('AL|AK|AZ|AR|CA|CO|CT|DE|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|'
               'MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|DC')
US_COUNTRY = re.compile(r'\b(?:United States(?: of America)?|USA|U\.S\.A\.?|U\.S\.?|US)\b', re.I)
FOREIGN = re.compile(r'\b(?:Singapore|Taiwan|Canada|United Kingdom|UK|Germany|France|India|Australia|'
                     r'Japan|China|Ireland|Netherlands|Switzerland|Brazil|Israel|New Zealand|'
                     r'Poland|Sweden|Italy|Spain|South Korea|Vietnam|Thailand|Argentina|'
                     r'Philippines|Malaysia|Indonesia|Hong Kong|United Arab Emirates|Dubai|'
                     r'South Africa|Portugal|Belgium|Austria|Denmark|Finland|Norway|Europe|EMEA|APAC)\b|(?<!New )\bMexico\b', re.I)
CITY_STATE = re.compile(r'\b[A-Za-z][A-Za-z .\'-]+,\s*(?:'+STATE_CODES+r')\b')
FULL_STATE = re.compile(r'\b(?:'+STATE_NAMES+r')\b', re.I)
# Sources often give a bare city ("Los Angeles"). Only cities with no common foreign
# namesake are listed (no London, Paris, Cambridge, Dublin, Birmingham, Vancouver).
US_CITIES = re.compile(r'\b(?:Los Angeles|San Francisco|South San Francisco|San Jose|San Diego|Santa Clara|'
                       r'Sunnyvale|Mountain View|Palo Alto|Menlo Park|Redwood City|Springfield|Cupertino|'
                       r'Milpitas|Fremont|Oakland|Berkeley|Pleasanton|Livermore|El Segundo|Hawthorne|'
                       r'Torrance|Long Beach|Irvine|Costa Mesa|Santa Barbara|Goleta|Carlsbad|Pasadena|'
                       r'Burbank|Culver City|Santa Monica|Mojave|Seattle|Redmond|Bellevue|Kirkland|'
                       r'Austin|Houston|Dallas|San Antonio|Denver|Boulder|Phoenix|Tucson|Chicago|Detroit|'
                       r'Pittsburgh|Philadelphia|Boston|Atlanta|Huntsville|Albuquerque|Salt Lake City|'
                       r'Las Vegas|Minneapolis|Nashville|Raleigh|Durham|Charlotte|Orlando|Tampa|Miami|'
                       r'Cape Canaveral|Brooklyn|Manhattan|Washington,? D\.?C\.?)\b', re.I)


def is_us_location(location):
    """Accept at least one explicitly U.S. work location; bare remote is not evidence."""
    if isinstance(location, (list, tuple)):
        return any(is_us_location(item) for item in location)
    if not isinstance(location, str) or not location.strip():
        return False
    # One posting can offer several countries. Evaluate each offered location separately;
    # foreign alternatives cannot lend their city/state fragments to a U.S. alternative.
    parts = re.split(r'[;\n|]|\s+/\s+', location)
    for part in parts:
        if FOREIGN.search(part):
            # An explicit U.S. country alongside another country is ambiguous: sources
            # should give separate location entries, not let a guess choose the country.
            continue
        if US_COUNTRY.search(part) or CITY_STATE.search(part) or US_CITIES.search(part):
            return True
        if FULL_STATE.search(part) and part.strip().lower() != 'georgia':
            return True
    return False

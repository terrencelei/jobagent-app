"""U.S. state of a posting's free-text location, for the dashboard's location filter.

Postings write places many ways ("Cupertino, CA", "Costa Mesa, California, United States", "US, Oregon, Hillsboro",
"San Francisco"). A state is read from its name, then from its two-letter code standing as its own word after a
comma, dash or space, then from a short list of well-known cities that boards list without a state.
"""
import re

STATES = {'AL': 'Alabama', 'AK': 'Alaska', 'AZ': 'Arizona', 'AR': 'Arkansas', 'CA': 'California', 'CO': 'Colorado', 'CT': 'Connecticut',
          'DE': 'Delaware', 'DC': 'District of Columbia', 'FL': 'Florida', 'GA': 'Georgia', 'HI': 'Hawaii', 'ID': 'Idaho', 'IL': 'Illinois',
          'IN': 'Indiana', 'IA': 'Iowa', 'KS': 'Kansas', 'KY': 'Kentucky', 'LA': 'Louisiana', 'ME': 'Maine', 'MD': 'Maryland', 'MA': 'Massachusetts',
          'MI': 'Michigan', 'MN': 'Minnesota', 'MS': 'Mississippi', 'MO': 'Missouri', 'MT': 'Montana', 'NE': 'Nebraska', 'NV': 'Nevada',
          'NH': 'New Hampshire', 'NJ': 'New Jersey', 'NM': 'New Mexico', 'NY': 'New York', 'NC': 'North Carolina', 'ND': 'North Dakota', 'OH': 'Ohio',
          'OK': 'Oklahoma', 'OR': 'Oregon', 'PA': 'Pennsylvania', 'PR': 'Puerto Rico', 'RI': 'Rhode Island', 'SC': 'South Carolina', 'SD': 'South Dakota',
          'TN': 'Tennessee', 'TX': 'Texas', 'UT': 'Utah', 'VT': 'Vermont', 'VA': 'Virginia', 'WA': 'Washington', 'WV': 'West Virginia', 'WI': 'Wisconsin', 'WY': 'Wyoming'}
CITIES = {'san francisco': 'CA', 'cupertino': 'CA', 'sunnyvale': 'CA', 'mountain view': 'CA', 'palo alto': 'CA', 'san jose': 'CA', 'santa clara': 'CA',
          'los angeles': 'CA', 'el segundo': 'CA', 'hawthorne': 'CA', 'long beach': 'CA', 'san diego': 'CA', 'irvine': 'CA', 'fremont': 'CA', 'menlo park': 'CA',
          'redwood city': 'CA', 'south san francisco': 'CA', 'bay area': 'CA', 'nyc': 'NY', 'new york city': 'NY', 'brooklyn': 'NY', 'seattle': 'WA',
          'redmond': 'WA', 'bellevue': 'WA', 'austin': 'TX', 'dallas': 'TX', 'houston': 'TX', 'starbase': 'TX', 'bastrop': 'TX', 'boston': 'MA',
          'cambridge, ma': 'MA', 'chicago': 'IL', 'atlanta': 'GA', 'denver': 'CO', 'boulder': 'CO', 'pittsburgh': 'PA', 'philadelphia': 'PA', 'detroit': 'MI',
          'phoenix': 'AZ', 'tucson': 'AZ', 'huntsville': 'AL', 'cape canaveral': 'FL', 'miami': 'FL', 'portland, or': 'OR', 'salt lake city': 'UT', 'las vegas': 'NV'}
_NAMES = sorted(STATES.items(), key=lambda item: -len(item[1]))
_CODE = re.compile(r'(?:^|[,\-–/(\s])(' + '|'.join(STATES) + r')(?=$|[,\-–/)\s\d])')
_FOREIGN = re.compile(r'\b(canada|mexico|united kingdom|uk|germany|india|china|japan|singapore|taiwan|malaysia|ireland|france|australia|korea|israel|netherlands|poland|spain|italy|brazil|switzerland|sweden)\b', re.I)


def state_of(location: str | None) -> str | None:
    """Two-letter state code, 'REMOTE' for a U.S. remote listing with no state, or None when no state can be read."""
    text = (location or '').strip()
    if not text:
        return None
    low = text.casefold()
    for code, name in _NAMES:
        if code == 'WA' and re.search(r'washington,?\s*d\.?c', low):
            return 'DC'
        if re.search(r'\b' + re.escape(name.casefold()) + r'\b', low) and not (code == 'NY' and 'new york' not in low):
            if code == 'WA' and re.search(r'\bDC\b', text):
                return 'DC'
            return code
    if not _FOREIGN.search(text):
        match = _CODE.search(text)
        if match:
            return match.group(1)
        for city, code in CITIES.items():
            if re.search(r'\b' + re.escape(city) + r'\b', low):
                return code
    if 'remote' in low and not _FOREIGN.search(text):
        return 'REMOTE'
    return None


def label(code: str) -> str:
    return 'Remote (U.S.)' if code == 'REMOTE' else STATES.get(code, code)

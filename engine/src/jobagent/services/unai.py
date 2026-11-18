"""Phrasing that reads as machine-written, after Wikipedia's "Signs of AI writing" (his request 2026-11-13: use
the un-ai rules on drafted short answers and on the dashboard's own wording).

`RULES` goes into the drafting prompt; `tells(text)` names the patterns a finished draft still shows, so the
drafter can revise it once before he sees it. A hit is a cue to reword, not proof of anything, and the check
never touches facts: a literal "key" or a real list of three is left to the reviser's judgement.
"""
import re

RULES = """Plain-writing rules (from Wikipedia's "Signs of AI writing"). Apply them without changing any fact:
- Say what the thing is or what he did. No significance claims: "stands as", "serves as", "is a testament to", "plays a
  crucial/pivotal/key role", "underscores", "reflects broader", "evolving landscape".
- Do not end a sentence with a participle phrase that asserts meaning (", highlighting ...", ", ensuring ...",
  ", demonstrating ...", ", fostering ..."). Delete it or state the specific result as its own sentence.
- No promotional words: boasts, vibrant, rich, profound, renowned, groundbreaking, cutting-edge, showcase, commitment to.
- Avoid: additionally (opening a sentence), align with, crucial, delve, enhance, foster, garner, highlight (verb),
  intricate, leverage, meticulous, pivotal, robust, seamless, tapestry, testament, underscore, valuable, passionate.
- No "not X, but Y", "not only ... but also", "it's not just X, it's Y". State the positive claim.
- No reflexive groups of three, no "from X to Y" unless those are real ends of a scale, and reuse the same noun
  instead of cycling synonyms.
- No reader-directed notes ("it's important to note"), no closing summary ("Overall", "In conclusion", "In summary").
- No em dashes; use a comma, colon or full stop. No bold, bullets, headings or emoji in an answer.
- Never make the text worse to sound human: no slang, typos or broken grammar."""

_PATTERNS = [
    ('significance claim', r'\b(stands? as|serves? as|is a testament|testament to|plays? an? (vital|pivotal|crucial|key|significant) role|underscor\w+|reflects? broader|evolving landscape|setting the stage|indelible|deeply rooted|focal point)\b'),
    ('tacked-on -ing clause', r',\s+(highlighting|underscoring|emphasizing|reflecting|ensuring|contributing to|fostering|demonstrating|showcasing|enabling|allowing me to|positioning me)\b'),
    ('promotional word', r'\b(boasts?|vibrant|profound(ly)?|renowned|groundbreaking|cutting[- ]edge|nestled|in the heart of|diverse array|showcas\w+|exemplif\w+|commitment to|world[- ]class|state[- ]of[- ]the[- ]art)\b'),
    ('AI vocabulary', r'\b(delv\w+|pivotal|crucial|meticulous(ly)?|intricat\w+|tapestry|interplay|garner\w*|bolster\w*|foster\w*|leverag\w+|seamless(ly)?|robust|align(s|ed|ing)? with|enhanc\w+|valuable|passionate|thrilled|excited to)\b|(^|[.!?]\s+)Additionally\b'),
    ('reader-directed note', r"\b(it'?s|it is) (important|worth|crucial) (to note|noting|to remember|to mention)\b"),
    ('summary ending', r'(^|[.!?]\s+)(In conclusion|Overall|In summary|To summarize|Ultimately|In short)\b'),
    ('negative parallelism', r"\bnot only\b|\bnot just\b|\bisn'?t just\b|\bnot merely\b|\brather than (just|simply|merely)\b"),
    ('em dash', r'\s?—\s?|\s–\s'),
    ('markdown or emoji', r'\*\*|^#{1,4}\s|^\s*[-*•]\s|[\U0001F300-\U0001FAFF]'),
    ('chatbot leftover', r'\b(I hope this helps|let me know if|as an AI|certainly!|happy to help)\b|\[[A-Z][A-Za-z ]+\]'),
]
_COMPILED = [(name, re.compile(pattern, re.I | re.M)) for name, pattern in _PATTERNS]


def tells(text: str) -> list:
    """The patterns this text shows, each with the words that triggered it: [(kind, phrase), ...]."""
    found = []
    for name, pattern in _COMPILED:
        for match in pattern.finditer(text or ''):
            phrase = match.group(0).strip(' ,.')
            if phrase and (name, phrase.casefold()) not in {(n, p.casefold()) for n, p in found}:
                found.append((name, phrase))
    return found

"""Semantic matching engine for role, experience, and skills similarity."""

import math
import re
from collections import Counter
from typing import Any, Dict, List, Optional, Set, Tuple

from ..processing.normalize import normalize_text


def tokenize(text: str) -> List[str]:
    """Tokenize and remove common stopwords."""
    words = re.findall(r"\b[a-zA-Z0-9_\-\+\#]{2,}\b", text.lower())
    stopwords = {
        "and", "the", "for", "with", "this", "that", "from", "are", "will", "our",
        "you", "your", "have", "all", "work", "team", "years", "role", "must",
        "able", "skills", "experience", "required", "preferred", "including"
    }
    return [w for w in words if w not in stopwords]


class SemanticMatcher:
    def __init__(self):
        self._cache: Dict[str, float] = {}

    def compute_cosine_similarity(self, text_a: str, text_b: str) -> float:
        """Compute cosine similarity over token frequencies with n-gram weighting."""
        tokens_a = tokenize(text_a)
        tokens_b = tokenize(text_b)
        if not tokens_a or not tokens_b:
            return 0.0

        vec_a = Counter(tokens_a)
        vec_b = Counter(tokens_b)

        intersection = set(vec_a.keys()) & set(vec_b.keys())
        numerator = sum(vec_a[x] * vec_b[x] for x in intersection)

        sum_a = sum(v ** 2 for v in vec_a.values())
        sum_b = sum(v ** 2 for v in vec_b.values())
        denominator = math.sqrt(sum_a) * math.sqrt(sum_b)

        if denominator == 0.0:
            return 0.0
        return float(numerator / denominator)

    def match_skills(
        self,
        text: str,
        explicit_skills: List[str],
        inferred_skills: List[str],
    ) -> Tuple[List[str], List[str], List[str]]:
        """
        Identify matching explicit skills, matching inferred skills, and candidate missing skills.
        Never hallucinate candidate skills!
        """
        text_lower = text.lower()
        matched_explicit = []
        matched_inferred = []

        for skill in explicit_skills:
            pattern = rf"\b{re.escape(skill.lower())}\b"
            if re.search(pattern, text_lower):
                matched_explicit.append(skill)

        for skill in inferred_skills:
            pattern = rf"\b{re.escape(skill.lower())}\b"
            if re.search(pattern, text_lower):
                matched_inferred.append(skill)

        # Detect common engineering skills mentioned in job but missing from candidate
        common_hardware_skills = [
            "Altium", "PLC", "LabVIEW", "FEA", "CFD", "CNC", "GD&T",
            "Thermal Analysis", "Vibration", "Optics", "Injection Molding",
            "Sheet Metal", "PCB Design", "Soldering", "Metrology", "CMM",
            "Ansys", "SolidWorks", "Creo", "NX", "MATLAB", "Simulink", "ROS",
            "Jira", "Confluence", "Agile", "Scrum", "Six Sigma", "Lean",
        ]
        all_candidate_skills = set(s.lower() for s in explicit_skills + inferred_skills)
        missing_skills = []

        for sk in common_hardware_skills:
            if sk.lower() not in all_candidate_skills:
                if re.search(rf"\b{re.escape(sk.lower())}\b", text_lower):
                    missing_skills.append(sk)

        return (matched_explicit, matched_inferred, missing_skills)

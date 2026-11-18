"""Explainable relevance scoring engine for JobAgent."""

import re

from ..processing.location_prefs import location_fit
from typing import Any, Dict, List, Optional, Tuple

from ..config import CandidateProfileConfig, RankingConfig, load_profile_config, load_ranking_config
from ..processing.eligibility import EligibilityEngine, split_required_and_preferred, clean_html_text
from ..processing.qualifications import documented_experience_years, experience_years, is_early_career, off_discipline_title, required_experience_years, SENIOR_PATTERN
from .career_clusters import CareerClusterEngine
from .semantic import SemanticMatcher
from .urgency import UrgencyEngine


class RelevanceScorer:
    def __init__(
        self,
        profile_config: Optional[CandidateProfileConfig] = None,
        ranking_config: Optional[RankingConfig] = None,
        track=None,
    ):
        from ..processing.tracks import get_track
        self.profile = profile_config or load_profile_config()
        self.ranking = ranking_config or load_ranking_config()
        self.track = track or get_track()
        self.semantic_matcher = SemanticMatcher()
        self.eligibility_engine = EligibilityEngine(self.profile, self.ranking, self.track)
        self.cluster_engine = CareerClusterEngine(self.ranking)
        self.urgency_engine = UrgencyEngine(self.ranking)

        # Precompute candidate skills
        self.explicit_skills = [
            *self.profile.skills.programming.get("explicit", []),
            *self.profile.skills.engineering.get("explicit", []),
        ]
        self.inferred_skills = [
            *self.profile.skills.programming.get("inferred", []),
            *self.profile.skills.engineering.get("inferred", []),
        ]

        # Experience signals mapped to weights
        self.experience_blocks = [
            (exp.company, exp.signals, exp.weight_multiplier)
            for exp in self.profile.experience
        ]
        self.project_blocks = [
            (proj.name, proj.signals, 1.3)
            for proj in self.profile.projects
        ]

    def score_job(
        self,
        title: str,
        description: str,
        company_name: str,
        location: Optional[str] = None,
        posting_date: Optional[Any] = None,
        discovery_date: Optional[Any] = None,
        has_start_date_conflict: bool = False,
        salary_min: Optional[float] = None,
    ) -> Dict[str, Any]:
        """
        Compute an explainable 0-100 relevance score and priority score.
        """
        required_text, preferred_text = split_required_and_preferred(description)
        # Primary fit uses duties and required qualifications, not company/title keywords
        # or preferred qualifications counted a second time.
        text_corpus = required_text.lower()
        title_lower = title.lower()
        weights = self.ranking.weights

        # 1. Semantic Role Match (Max 25)
        # Check title alignment with engineering targets
        role_score = 0.0
        target_roles = list(self.track.target_roles)
        role_hits = [r for r in target_roles if r in title_lower]
        desc_hits = [r for r in target_roles if re.search(rf"\b{re.escape(r)}(?:s|ing)?\b", text_corpus)]
        role_score = min(20.0, len(desc_hits) * 3.5) + min(5.0, len(role_hits) * 2.5)

        # 2. Technical Skill Match (Max 20)
        matched_explicit, matched_inferred, missing_skills = self.semantic_matcher.match_skills(
            text_corpus, self.explicit_skills, self.inferred_skills
        )
        skill_points = (len(matched_explicit) * 4.0) + (len(matched_inferred) * 2.0)
        skill_score = min(20.0, skill_points)

        # 3. Experience Match (Max 20)
        def _match_signal(sig: str, text: str) -> bool:
            s_clean = sig.lower()
            if re.search(rf"\b{re.escape(s_clean)}\b", text):
                return True
            if s_clean.endswith("s") and re.search(rf"\b{re.escape(s_clean[:-1])}\b", text):
                return True
            if not s_clean.endswith("s") and re.search(rf"\b{re.escape(s_clean + 's')}\b", text):
                return True
            key_nouns = ["mechanism", "actuator", "semiconductor", "motor", "robot", "aerospace", "tolerance", "sensor"]
            for kn in key_nouns:
                if kn in s_clean and re.search(rf"\b{kn}\w*\b", text):
                    return True
            return False

        matching_experience = []
        exp_raw_points = 0.0

        for comp_name, signals, mult in self.experience_blocks:
            hits = [s for s in signals if _match_signal(s, text_corpus)]
            if hits:
                matching_experience.append(f"{comp_name}: {', '.join(hits[:4])}")
                exp_raw_points += len(hits) * 3.0 * mult

        for proj_name, signals, mult in self.project_blocks:
            hits = [s for s in signals if _match_signal(s, text_corpus)]
            if hits:
                matching_experience.append(f"{proj_name}: {', '.join(hits[:4])}")
                exp_raw_points += len(hits) * 2.5 * mult

        exp_score = min(20.0, exp_raw_points)

        # 4. Industry Match (Max 10)
        target_industries = list(self.track.industries)
        ind_hits = [ind for ind in target_industries if re.search(rf"\b{re.escape(ind)}\b", text_corpus)]
        industry_score = min(10.0, len(ind_hits) * 5.0) if ind_hits else 0.0

        # 5. Early-Career Fit (Max 10) & Special New-Grad Boost
        early_career_boost_applied = is_early_career(title)
        early_career_score = 10.0 if early_career_boost_applied or is_early_career(required_text) else 5.0

        # 6. Role Preference (Max 5)
        role_pref_score = 4.0 if any(r in title_lower for r in self.track.preferred_title_terms) else 3.0

        # 7. Location Preference (Max 5): the places the student chose in Setup.
        loc_clean = (location or "").lower()
        cand = self.profile.candidate if isinstance(self.profile.candidate, dict) else {}
        loc_pref_score, _ = location_fit(location or "", cand.get("target_locations") or [], bool(cand.get("remote_ok", True)))

        # 8. Company Preference (Max 5), by sector rather than a flat list of favourites.
        # The candidate stated a preference for consumer tech and robotics over defense,
        # aerospace and automotive, so that ordering lives in config and is auditable.
        comp_clean = company_name.lower()
        pref = self.ranking.company_preference if hasattr(self.ranking, "company_preference") else {}
        if not isinstance(pref, dict):
            pref = {}
        company_pref_score = float(pref.get("default_points", 3.0))
        sector_priority_boost = 0.0
        best_match = ""
        for sector in (pref.get("sectors") or {}).values():
            for name in sector.get("companies") or []:
                # A longer name wins, so "boston dynamics" is not shadowed by a short token.
                if re.search(r'(?<!\w)' + re.escape(name.lower()) + r'(?!\w)', comp_clean) and len(name) > len(best_match):
                    best_match = name
                    company_pref_score = float(sector.get("points", company_pref_score))
                    sector_priority_boost = float(sector.get("priority_boost", 0))

        # Penalties:
        penalties = 0.0
        if re.search(SENIOR_PATTERN, title_lower):
            penalties += self.ranking.penalties.get("senior_title_penalty", 45.0)

        if has_start_date_conflict:
            penalties += self.ranking.penalties.get("start_date_conflict_penalty", 35.0)

        # Fit reads the title too: another discipline's job is not a fit for his majors.
        if off_discipline_title(title, clean_html_text(description), self.track):
            penalties += self.ranking.penalties.get("off_discipline_title_penalty", 40.0)

        # Salary threshold penalty
        cand_dict = self.profile.candidate if isinstance(self.profile.candidate, dict) else self.profile.candidate.__dict__
        target_salary = cand_dict.get("salary_threshold_annual", 90000) or 90000
        if salary_min is not None and isinstance(salary_min, (int, float)) and 0 < salary_min < target_salary:
            penalties += self.ranking.penalties.get("salary_below_threshold_penalty", 30.0)

        # Geographic outside US penalty
        non_us_markers = [
            "united kingdom", "london", "uk", "germany", "berlin", "munich",
            "canada", "toronto", "vancouver", "waterloo", "montreal", "france", "paris",
            "india", "bengaluru", "bangalore", "australia", "sydney", "singapore", "japan", "tokyo",
            "switzerland", "china", "taiwan", "ireland", "dublin"
        ]
        if loc_clean and any(re.search(rf"\b{re.escape(m)}\b", loc_clean) for m in non_us_markers):
            if not any(re.search(rf"\b{re.escape(u)}\b", loc_clean) for u in ["united states", "hybrid - us", "us only"]):
                penalties += self.ranking.penalties.get("outside_us_penalty", 50.0)

        # Experience mismatch penalty (> 3 years required experience for early-career candidate)
        # Evaluated on required qualifications only; preferred qualifications do not trigger penalty
        exp_min = required_experience_years(required_text)
        if exp_min is not None and exp_min >= cand_dict.get("max_required_experience_years", 3):
            penalties += self.ranking.penalties.get("experience_mismatch_penalty", 35.0)

        # Years of experience, required and preferred, against his dated experience.
        from ..settings import setting
        req_years, pref_years = experience_years(description)
        have = documented_experience_years(self.profile)
        experience_adjustment = 0.0
        if req_years is not None:
            if req_years == 0:
                experience_adjustment += setting('experience.zero_required_bonus')
            elif req_years < cand_dict.get("max_required_experience_years", 3):  # 3+ already carries its own penalty
                experience_adjustment -= max(0.0, req_years - have) * setting('experience.required_penalty_per_year')
        if pref_years is not None:
            experience_adjustment -= min(setting('experience.preferred_penalty_cap'),
                                         max(0.0, pref_years - have) * setting('experience.preferred_penalty_per_year'))
        experience_line = (f"Experience: {'not stated' if req_years is None else f'{req_years}+ yrs required'}"
                           f"{'' if pref_years is None else f', {pref_years}+ yrs preferred'}; you have ~{have:.1f} yrs documented"
                           f"{f' ({experience_adjustment:+.1f} pts)' if experience_adjustment else ''}.")

        # Preferred qualifications bonus (up to 5.0 pts)
        # Judged based on candidate profile skills and experience signals matching preferred qualifications
        preferred_matches: List[str] = []
        pref_bonus = 0.0
        if preferred_text:
            p_lower = preferred_text.lower()
            for sk in self.explicit_skills + self.inferred_skills:
                if re.search(rf"\b{re.escape(sk.lower())}\b", p_lower):
                    preferred_matches.append(sk)
            for exp in self.profile.experience:
                for sig in exp.signals:
                    if re.search(rf"\b{re.escape(sig.lower())}\b", p_lower):
                        preferred_matches.append(sig)
            preferred_matches = list(dict.fromkeys(preferred_matches))
            if preferred_matches:
                pref_bonus = min(5.0, len(preferred_matches) * 2.0)

        # Raw total relevance (0-100)
        total_relevance = (
            role_score + skill_score + exp_score + industry_score +
            early_career_score + role_pref_score + loc_pref_score + company_pref_score +
            pref_bonus
        )
        total_relevance = max(0.0, min(100.0, total_relevance - penalties + experience_adjustment))

        eligibility, eligibility_reasons, _, _ = self.eligibility_engine.evaluate(
            title, description, location, salary_min=salary_min)
        eligible = eligibility.value in ("ELIGIBLE", "LIKELY_ELIGIBLE", "STRONG_MATCH")
        before_gate = total_relevance
        if not eligible:
            # Keyword-rich but unqualified/unverified postings must not look like strong fits.
            total_relevance = min(total_relevance, 25.0)
        eligibility_adjustment = before_gate - total_relevance

        # Career clusters
        best_cluster, cluster_scores = self.cluster_engine.score_clusters(title, required_text, self.track.clusters)

        # Urgency & Priority calculation
        urgency_score, urgency_level, urgency_explanation = self.urgency_engine.calculate_urgency(
            posting_date, discovery_date, description
        )

        p_rel_w = self.ranking.priority_formula.get("relevance_weight", 0.75)
        p_urg_w = self.ranking.priority_formula.get("urgency_weight", 0.25)
        salary_ok = salary_min is None or salary_min >= target_salary
        # The student's first target role (Setup) adds its own priority points on top of the company boost.
        focus = self.track.preferred_title_terms[0].lower() if self.track.preferred_title_terms else ""
        focus_title_boost = float(self.ranking.priority_formula.get("focus_title_boost", 0.0)) if focus and re.search(rf"\b{re.escape(focus)}\b", title_lower) else 0.0
        boostable = eligible and salary_ok and not has_start_date_conflict and self.eligibility_engine.classify_role_type(title, description) == 'FULL_TIME'
        priority_boost = sector_priority_boost + focus_title_boost if boostable else 0.0
        priority_score = round(min(100.0, (p_rel_w * total_relevance) + (p_urg_w * urgency_score) + priority_boost), 1)

        # Generate human-readable explanation
        explanation_lines = [
            "Fit evidence: role duties and required qualifications; preferred criteria contribute only a separate bonus.",
            f"Eligibility: {eligibility.value}. " + " ".join(eligibility_reasons),
            f"Overall Relevance: {round(total_relevance, 1)}/100 | Best Cluster: {best_cluster}",
            f"Role Match: {round(role_score, 1)}/25, Skill Match: {round(skill_score, 1)}/20, Experience Match: {round(exp_score, 1)}/20",
            experience_line,
            f"Matching explicit skills: {', '.join(matched_explicit) if matched_explicit else 'None directly mentioned'}",
            f"Matching experience blocks: {'; '.join(matching_experience) if matching_experience else 'General engineering alignment'}",
        ]
        if eligibility_adjustment:
            explanation_lines.append(f"Eligibility adjustment: -{eligibility_adjustment:.1f} pts; unsuitable or unverified roles are capped at 25/100 fit.")
        if priority_boost:
            reasons = [r for r, on in (("one of your dream companies", sector_priority_boost), (f"your top role ({focus})", focus_title_boost)) if on]
            explanation_lines.append(f"Priority preference: +{priority_boost:g} points for {' and '.join(reasons)}. Fit score is unchanged.")
        if preferred_matches:
            explanation_lines.append(
                f"Preferred qualifications bonus (+{pref_bonus:.1f} pts): {', '.join(preferred_matches[:4])}"
            )
        if missing_skills:
            explanation_lines.append(f"Noted qualifications to highlight/learn: {', '.join(missing_skills[:5])}")
        if penalties > 0:
            explanation_lines.append(f"Penalties applied: -{penalties:.1f} pts")

        return {
            "relevance_score": round(total_relevance, 1),
            "urgency_score": round(urgency_score, 1),
            "urgency_level": urgency_level,
            "urgency_explanation": urgency_explanation,
            "priority_score": priority_score,
            "best_career_cluster": best_cluster,
            "cluster_scores": cluster_scores,
            "early_career_boost": early_career_boost_applied,
            "experience_required_years": req_years,
            "experience_preferred_years": pref_years,
            "breakdown": {
                "semantic_role_match": round(role_score, 1),
                "technical_skill_match": round(skill_score, 1),
                "experience_match": round(exp_score, 1),
                "industry_match": round(industry_score, 1),
                "early_career_fit": round(early_career_score, 1),
                "role_preference": round(role_pref_score, 1),
                "location_preference": round(loc_pref_score, 1),
                "company_preference": round(company_pref_score, 1),
                "preferred_qualifications_bonus": round(pref_bonus, 1),
                "matching_preferred_signals": preferred_matches,
                "penalties": round(penalties, 1),
                "matching_skills": matched_explicit + matched_inferred,
                "missing_skills": missing_skills,
                "matching_experience": matching_experience,
                "explanation": "\n".join(explanation_lines),
            }
        }

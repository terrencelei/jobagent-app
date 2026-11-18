"""Career direction clustering and multi-disciplinary scoring."""

import re
from typing import Any, Dict, List, Optional, Tuple
from ..config import RankingConfig, load_ranking_config


class CareerClusterEngine:
    def __init__(self, ranking_config: Optional[RankingConfig] = None):
        config = ranking_config or load_ranking_config()
        self.clusters = config.career_clusters

    def score_clusters(self, title: str, description: str, allowed=None) -> Tuple[str, Dict[str, float]]:
        """
        Score a job against all career clusters.
        Returns: (best_cluster_name, cluster_scores_dict)
        """
        title_clean = title.lower()
        desc_clean = description.lower()
        cluster_scores: Dict[str, float] = {}

        for cluster in self.clusters:
            c_name = cluster["name"]
            if allowed is not None and c_name not in allowed:
                continue  # another track's discipline
            keywords = cluster.get("keywords", [])

            # Keyword occurrence calculations
            title_hits = 0
            desc_hits = 0

            for kw in keywords:
                kw_lower = kw.lower()
                # Title matches have strong weight
                if re.search(rf"\b{re.escape(kw_lower)}\b", title_clean):
                    title_hits += 1
                # Description matches
                matches = len(re.findall(rf"\b{re.escape(kw_lower)}\b", desc_clean))
                if matches > 0:
                    desc_hits += min(matches, 3)  # cap repeat matches

            # Score calculation: base + title match bonus + description breadth
            raw_score = (title_hits * 35.0) + (desc_hits * 8.0)

            # Extra cluster-specific domain heuristics
            if c_name == "PRODUCT / MECHANICAL DESIGN":
                if any(t in title_clean for t in ["product design", "mechanical design", "pde", "mde"]):
                    raw_score += 30.0
            elif c_name == "ROBOTICS / MECHATRONICS":
                if any(t in title_clean for t in ["robotics", "mechatronics", "autonomous", "controls"]):
                    raw_score += 30.0
            elif c_name == "HARDWARE / SYSTEMS":
                if any(t in title_clean for t in ["hardware engineer", "systems engineer", "electromechanical"]):
                    raw_score += 30.0
            elif c_name == "MANUFACTURING / EQUIPMENT / AUTOMATION":
                if any(t in title_clean for t in ["manufacturing", "equipment", "automation", "npi", "tooling"]):
                    raw_score += 30.0
            elif c_name == "AEROSPACE / VEHICLE":
                if any(t in title_clean for t in ["aerospace", "vehicle", "propulsion", "structures", "spacecraft"]):
                    raw_score += 30.0
            elif c_name == "TECHNICAL PROGRAM MANAGEMENT":
                if any(t in title_clean for t in ["technical program manager", "program manager", "tpm", "project manager"]):
                    raw_score += 40.0
            elif c_name == "DATA / ENGINEERING ANALYTICS":
                if any(t in title_clean for t in ["data", "analytics", "reliability", "failure analysis"]):
                    raw_score += 30.0

            # Scale to 0-100
            final_score = round(min(100.0, max(15.0, raw_score)), 1)
            cluster_scores[c_name] = final_score

        # Select highest scoring cluster. Every cluster has a floor of 15, so a posting with no
        # signal for any of them used to fall to the first one listed (Product / Mechanical
        # Design) and pass the autoplay discipline filter. It belongs to none of them.
        best_cluster, best = max(cluster_scores.items(), key=lambda x: x[1])
        from ..settings import setting
        if best < setting('scoring.discipline_min_score'):  # by default: under three keyword mentions, none in the title
            best_cluster = "OTHER"
        return (best_cluster, cluster_scores)

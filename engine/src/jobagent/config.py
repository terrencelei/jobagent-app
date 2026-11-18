"""Configuration management for JobAgent."""

from pathlib import Path
from typing import Any, Dict, List, Literal, Optional
import os
import yaml
from pydantic import BaseModel, Field

ROOT_DIR = Path(__file__).resolve().parent.parent.parent
# The user's own files: written by Setup, never committed. JOBAGENT_HOME (set by the desktop app to a
# per-user folder) holds config/ and data/; JOBAGENT_CONFIG_DIR / JOBAGENT_DATA_DIR override each one.
_HOME = Path(os.environ["JOBAGENT_HOME"]).expanduser() if os.environ.get("JOBAGENT_HOME") else ROOT_DIR
DEFAULT_CONFIG_DIR = Path(os.environ.get("JOBAGENT_CONFIG_DIR") or _HOME / "config")
DEFAULT_DATA_DIR = Path(os.environ.get("JOBAGENT_DATA_DIR") or _HOME / "data")
# The application agent ships beside the engine (../agent in the repo, resources/agent in the app).
AGENT_DIR = Path(os.environ.get("JOBAGENT_APPLICATION_AGENT_DIR") or ROOT_DIR.parent / "agent")
# Shipped defaults, used for any file the user has not got yet (a fresh install before Setup).
SHIPPED_DEFAULTS = ROOT_DIR / "config" / "defaults"


def config_path(name: str, config_dir: Optional[Path] = None) -> Path:
    """The user's copy of a config file, or the shipped default when there is none yet."""
    own = Path(config_dir or DEFAULT_CONFIG_DIR) / name
    return own if own.exists() else SHIPPED_DEFAULTS / name


class CandidateEducation(BaseModel):
    institution: str
    degree: str
    majors: List[Dict[str, Any]]
    expected_graduation: str
    graduation_date: str
    gpa: str
    coursework: List[str] = Field(default_factory=list)


class CandidateExperience(BaseModel):
    company: str
    title: str
    start_date: str
    end_date: Optional[str] = None
    is_current: bool = False
    weight_multiplier: float = 1.0
    summary: str
    signals: List[str] = Field(default_factory=list)


class CandidateProject(BaseModel):
    name: str
    role: str
    summary: str
    signals: List[str] = Field(default_factory=list)


class CandidateSkills(BaseModel):
    programming: Dict[str, List[str]] = Field(default_factory=dict)
    engineering: Dict[str, List[str]] = Field(default_factory=dict)


class CandidateProfileConfig(BaseModel):
    candidate: Dict[str, Any]
    education: CandidateEducation
    experience: List[CandidateExperience] = Field(default_factory=list)
    projects: List[CandidateProject] = Field(default_factory=list)
    skills: CandidateSkills


class RankingConfig(BaseModel):
    weights: Dict[str, float]
    priority_formula: Dict[str, float]
    early_career_boost: Dict[str, Any]
    penalties: Dict[str, float]
    start_date_rules: Dict[str, Any]
    career_clusters: List[Dict[str, Any]]
    # Sector ordering for the company-preference component; absent means every employer
    # scores the same, which is how this behaved before the preference was configurable.
    company_preference: Dict[str, Any] = {}


class GitHubSource(BaseModel):
    repository: str = Field(pattern=r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$")
    ref: str = "main"
    path: str = "README.md"
    format: Literal["markdown", "simplify_json"] = "markdown"
    enabled: bool = True
    max_jobs: int = Field(default=250, ge=1, le=5000)
    max_details: int = Field(default=40, ge=0, le=250)
    resolve_redirect_hosts: List[str] = Field(default_factory=list)


class IndeedSearch(BaseModel):
    """Queries sent to the Indeed app's job-search API (discovery/indeed.py); timing and limits are settings."""
    location: str = "United States"
    queries: List[str] = Field(default_factory=list)
    # Link shorteners whose target is the employer page (grnh.se is Greenhouse's).
    resolve_redirect_hosts: List[str] = Field(default_factory=lambda: ["grnh.se"])


class LinkedInSearch(BaseModel):
    """Keywords sent to LinkedIn's public job search (discovery/linkedin.py); timing and limits are settings."""
    location: str = "United States"
    queries: List[str] = Field(default_factory=list)


class HandshakeSearch(BaseModel):
    """Keywords sent to Handshake's student job search with his signed-in session (discovery/handshake.py)."""
    # The school's Handshake subdomain (e.g. "myschool" for myschool.joinhandshake.com); empty uses app.joinhandshake.com.
    school: str = ""
    queries: List[str] = Field(default_factory=list)


class SearchConfig(BaseModel):
    cadence: Dict[str, Any]
    query_templates: Dict[str, List[str]]
    target_companies: Dict[str, List[Dict[str, Any]]]
    locations: Dict[str, Any]
    github_sources: List[GitHubSource] = Field(default_factory=lambda: [GitHubSource(
        repository="SimplifyJobs/New-Grad-Positions", ref="dev",
        path=".github/scripts/listings.json", format="simplify_json")])
    indeed: IndeedSearch = Field(default_factory=IndeedSearch)
    linkedin: LinkedInSearch = Field(default_factory=LinkedInSearch)
    handshake: HandshakeSearch = Field(default_factory=HandshakeSearch)


class AppSettings(BaseModel):
    root_dir: Path = ROOT_DIR
    config_dir: Path = DEFAULT_CONFIG_DIR
    data_dir: Path = DEFAULT_DATA_DIR
    db_url: str = f"sqlite:///{DEFAULT_DATA_DIR}/jobagent.db"
    log_level: str = "INFO"
    server_host: str = "127.0.0.1"
    server_port: int = 8000
    request_timeout: float = 15.0
    rate_limit_delay: float = 1.0
    user_agent: str = (
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 JobAgent/1.0"
    )

    def ensure_dirs(self) -> None:
        self.data_dir.mkdir(parents=True, exist_ok=True)
        self.config_dir.mkdir(parents=True, exist_ok=True)


def load_yaml(file_path: Path) -> Dict[str, Any]:
    if not file_path.exists():
        raise FileNotFoundError(f"Configuration file not found: {file_path}")
    with open(file_path, "r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def get_settings() -> AppSettings:
    db_url = os.environ.get("JOBAGENT_DB_URL")
    config_dir_env = os.environ.get("JOBAGENT_CONFIG_DIR")
    config_dir = Path(config_dir_env) if config_dir_env else DEFAULT_CONFIG_DIR

    settings = AppSettings(
        config_dir=config_dir,
        data_dir=DEFAULT_DATA_DIR,
        db_url=db_url or f"sqlite:///{DEFAULT_DATA_DIR}/jobagent.db",
        log_level=os.environ.get("JOBAGENT_LOG_LEVEL", "INFO"),
        server_host=os.environ.get("JOBAGENT_SERVER_HOST", "127.0.0.1"),
        server_port=int(os.environ.get("JOBAGENT_SERVER_PORT", "8000")),
    )
    settings.ensure_dirs()
    return settings


def load_profile_config(config_dir: Optional[Path] = None) -> CandidateProfileConfig:
    data = load_yaml(config_path("profile.yaml", config_dir))
    # His dashboard settings override the YAML defaults.
    from .settings import apply_config_overrides
    return CandidateProfileConfig(**apply_config_overrides("profile.yaml", data))


def load_search_config(config_dir: Optional[Path] = None) -> SearchConfig:
    data = load_yaml(config_path("search.yaml", config_dir))
    # His dashboard settings override the YAML defaults.
    from .settings import apply_config_overrides
    return SearchConfig(**apply_config_overrides("search.yaml", data))


def load_ranking_config(config_dir: Optional[Path] = None) -> RankingConfig:
    data = load_yaml(config_path("ranking.yaml", config_dir))
    # His dashboard settings override the YAML defaults.
    from .settings import apply_config_overrides
    return RankingConfig(**apply_config_overrides("ranking.yaml", data))

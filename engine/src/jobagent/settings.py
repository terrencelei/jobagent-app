"""Every tunable parameter of JobAgent and the application agent, editable from the dashboard.

The registry below is the single list of knobs: label, help, type, bounds and default. His changes
are kept in data/settings.json; the file also carries the effective value of every setting so the
application agent (Node) can read the same values. Settings with a `config` path override that
value of the YAML configs at load time, so the YAML files remain the defaults.
"""
import json
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional, Tuple


@dataclass(frozen=True)
class Setting:
    key: str
    group: str
    label: str
    help: str
    type: str                      # int | float | bool | choice | minutes_list | text
    default: Any
    min: Optional[float] = None
    max: Optional[float] = None
    choices: Tuple[str, ...] = ()
    config: Optional[Tuple[str, ...]] = None  # (yaml file, key path...) this setting overrides
    applies: str = 'next use'      # when a change takes effect
    used_by: str = 'jobagent'


MODELS = ('sonnet', 'opus', 'haiku')
G_TUNE, G_REVIEW, G_RULES, G_AUTO, G_PRUNE, G_DISCOVERY, G_WORKER, G_WORKDAY = (
    'Rule self-tuning', 'Fit reviewer', 'Eligibility & scoring', 'Autoplay & workers', 'Pruning',
    'Discovery & sources', 'Application worker', 'Workday runner')
G_EMAIL = 'Email job alerts'
G_INDEED = 'Indeed search'
G_LINKEDIN = 'LinkedIn search'
G_HANDSHAKE = 'Handshake search'
ALERT_SENDERS = ('jobalerts-noreply@linkedin.com OR joinhandshake.com OR ziprecruiter.com OR lensa.com OR wayup.com '
                 'OR ev.careers OR jobs2web.com OR clinchtalent.com OR careerbrew@substack.com OR noreply@oracle.com '
                 'OR indeed.com OR glassdoor.com OR simplify.jobs OR wellfound.com')
RESCORE = 'after Rescore postings'

REGISTRY = [
    # Rule self-tuning (services/rule_tuner.py)
    Setting('tuner.enabled', G_TUNE, 'Let the rules revise themselves', 'When the fixed rules drift from the reviewer and your labels, propose and apply revised title/degree patterns.', 'bool', True),
    Setting('tuner.min_evidence', G_TUNE, 'Judged postings needed', 'Postings with your label or a current reviewer verdict, per track, before the rules are compared.', 'int', 20, 5, 500),
    Setting('tuner.min_disagreements', G_TUNE, 'Disagreements needed', 'Minimum number of postings where rules and truth differ.', 'int', 5, 1, 200),
    Setting('tuner.disagreement_rate', G_TUNE, 'Disagreement rate that triggers a revision', 'Share of judged postings the rules get wrong (0.20 = 20%).', 'float', 0.20, 0.01, 1.0),
    Setting('tuner.new_evidence', G_TUNE, 'New judged postings between attempts', 'Fresh evidence required since the last attempt.', 'int', 10, 0, 500),
    Setting('tuner.cooldown_hours', G_TUNE, 'Hours between attempts', 'Minimum wait between revision attempts per track.', 'float', 12, 0, 720),
    Setting('tuner.required_gain', G_TUNE, 'Required agreement gain', 'A revision is applied only if replayed agreement rises by at least this much (0.05 = 5 points), and never falls on your labels.', 'float', 0.05, 0.0, 1.0),
    Setting('tuner.model', G_TUNE, 'Model that proposes revisions', 'Claude model used through the CLI on your plan.', 'choice', 'sonnet', choices=MODELS),

    # Fit reviewer (services/fit_review.py)
    Setting('review.required', G_REVIEW, 'Autoplay only takes reviewed fits', 'Off: autoplay takes rule matches without a model reading them first.', 'bool', True),
    Setting('review.model', G_REVIEW, 'Reviewer model', 'Claude model used through the CLI on your plan.', 'choice', 'sonnet', choices=MODELS),
    Setting('review.batch', G_REVIEW, 'Postings per review batch', 'How many postings are read per background batch.', 'int', 4, 1, 50),
    Setting('review.fresh_picks', G_REVIEW, 'Upcoming picks re-reviewed after a label', 'After you label, this many of the next autoplay picks are read again with your new example.', 'int', 12, 0, 100),
    Setting('review.pause_minutes', G_REVIEW, 'Pause after a failed review (minutes)', 'Usually a plan limit; reviews wait this long before trying again.', 'float', 30, 1, 1440),
    Setting('review.label_settle_minutes', G_REVIEW, 'Minutes before a label is used as a lesson', 'Lets you label a run of postings before the reviewer re-reads anything.', 'float', 2, 0, 120),
    Setting('review.max_examples', G_REVIEW, 'Labelled examples shown to the reviewer', 'Your labels given as worked examples, the reviewer\'s past mistakes first.', 'int', 40, 0, 200),
    Setting('review.max_description_chars', G_REVIEW, 'Posting characters the reviewer reads', 'Longer descriptions are cut to this length.', 'int', 15000, 1000, 60000),
    Setting('review.timeout_seconds', G_REVIEW, 'Reviewer timeout (seconds)', 'Per posting.', 'int', 240, 30, 1200),

    # Eligibility & scoring (config/profile.yaml, config/ranking.yaml, rules)
    Setting('profile.salary_threshold_annual', G_RULES, 'Salary floor ($/year)', 'A stated base below this adds a penalty and a note.', 'int', None, 0, 500000, config=('profile.yaml', 'candidate', 'salary_threshold_annual'), applies=RESCORE),
    Setting('profile.max_required_experience_years', G_RULES, 'Years of required experience that rule a role out', 'Postings requiring this many years or more are likely ineligible.', 'int', None, 1, 15, config=('profile.yaml', 'candidate', 'max_required_experience_years'), applies=RESCORE),
    Setting('ranking.relevance_weight', G_RULES, 'Priority weight on fit', 'Priority = fit weight x fit + urgency weight x urgency.', 'float', None, 0, 1, config=('ranking.yaml', 'priority_formula', 'relevance_weight'), applies=RESCORE),
    Setting('ranking.urgency_weight', G_RULES, 'Priority weight on urgency', 'Urgency comes from posting age and deadlines.', 'float', None, 0, 1, config=('ranking.yaml', 'priority_formula', 'urgency_weight'), applies=RESCORE),
    Setting('ranking.focus_title_boost', G_RULES, 'Priority boost: your top target role', 'Priority points added to a full-time posting whose title names the first role you chose in Setup; stacks with the dream-company boost.', 'float', None, 0, 50, config=('ranking.yaml', 'priority_formula', 'focus_title_boost'), applies=RESCORE),
    Setting('ranking.off_discipline_title_penalty', G_RULES, 'Penalty: title from another discipline', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'off_discipline_title_penalty'), applies=RESCORE),
    Setting('ranking.senior_title_penalty', G_RULES, 'Penalty: senior title', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'senior_title_penalty'), applies=RESCORE),
    Setting('ranking.start_date_conflict_penalty', G_RULES, 'Penalty: start date before you are available', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'start_date_conflict_penalty'), applies=RESCORE),
    Setting('ranking.salary_below_threshold_penalty', G_RULES, 'Penalty: salary below your floor', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'salary_below_threshold_penalty'), applies=RESCORE),
    Setting('ranking.experience_mismatch_penalty', G_RULES, 'Penalty: too many required years', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'experience_mismatch_penalty'), applies=RESCORE),
    Setting('ranking.outside_us_penalty', G_RULES, 'Penalty: outside the US', 'Fit points taken off.', 'float', None, 0, 100, config=('ranking.yaml', 'penalties', 'outside_us_penalty'), applies=RESCORE),
    Setting('experience.required_penalty_per_year', G_RULES, 'Fit points per required year beyond your experience', 'Measured against your dated work history (internships and research), about 1.2 years now.', 'float', 8, 0, 50, applies=RESCORE),
    Setting('experience.preferred_penalty_per_year', G_RULES, 'Fit points per preferred year beyond your experience', 'Preferred years never make a role ineligible; they only lower fit.', 'float', 3, 0, 30, applies=RESCORE),
    Setting('experience.preferred_penalty_cap', G_RULES, 'Most fit points preferred years can take off', '', 'float', 10, 0, 50, applies=RESCORE),
    Setting('experience.zero_required_bonus', G_RULES, 'Fit bonus when no experience is required', 'For postings that state 0 years (or a 0-N range).', 'float', 3, 0, 20, applies=RESCORE),
    Setting('scoring.discipline_min_score', G_RULES, 'Minimum discipline score', 'Below this a posting is filed under Other (no discipline), which autoplay skips.', 'float', 24, 15, 100, applies=RESCORE),

    # Autoplay & workers (services/application_runner.py)
    Setting('workers.auto_submit', G_AUTO, 'Submit completed applications automatically', 'Standing authorization: submit once after required answers and resume pass validation. Missing personal facts still stop preparation.', 'bool', False),
    Setting('workers.scripted_actions', G_AUTO, 'Script confirmed form answers before asking an agent', 'Use validated saved facts for routine fields and sign-in; keep agents for unfamiliar questions and technical challenges. All application checks still apply.', 'bool', True),
    Setting('workers.direct_control', G_AUTO, 'Let one Claude session drive the browser directly', 'Claude Desktop-style control: when a form page still has three or more open required questions, or the step loop is stuck, one Claude session fills the whole page instead of one agent step per field. It can sign in or create an account with the saved password (which it never sees), request a reset email and attach the resume, on every browser route. The worker still asks you about undecided questions, validates, submits and reads emailed codes. Workday keeps its own driver.', 'bool', True),
    Setting('workers.usage_pause_percent', G_AUTO, 'Switch application agents to fallback models at this Claude usage %', 'Checked every 10 minutes from the Claude plan (5-hour and weekly windows). At or above this, application steps use agy models, then available OpenCode models, until Claude usage resets. 0 turns it off.', 'int', 80, 0, 100),
    Setting('workers.max_parallelism', G_AUTO, 'Most workers at once', 'Upper limit for the Applications panel; workers start as capacity and employer limits allow.', 'int', 20, 1, 50),
    Setting('workers.attention_soft_limit', G_AUTO, 'Attention backlog before pausing new applications', 'New applications slow as combined Approvals and Needs help approach this count. Resolved applications continue within resource and hard backlog limits.', 'int', 20, 1, 1000),
    Setting('workers.max_repair_agents', G_AUTO, 'Most help repair agents at once', 'Concurrent technical diagnosis agents, including active manual Help chats. Application submission protections still apply.', 'int', 4, 1, 10),
    Setting('workers.breaker_failures', G_AUTO, 'Identical failures before a site is held', 'When this many different postings fail with the same error on one site within the window, new applications there wait and one repair agent covers that error. 0 turns it off.', 'int', 3, 0, 20),
    Setting('workers.breaker_window_minutes', G_AUTO, 'Window for counting identical failures', 'Minutes in which the identical failures must happen to hold a site.', 'int', 120, 10, 1440),
    Setting('workers.breaker_hold_hours', G_AUTO, 'Longest a site stays held', 'A held site opens again after this many hours even if the repair did not finish; you can also resume it from the dashboard.', 'int', 6, 1, 48),
    Setting('workers.apply_internships', G_AUTO, 'Apply to internships', 'Off (his choice, 2026-11-02: "dont apply intern roles anymore"): only full-time roles are queued or applied to; a posting titled Intern, Internship or Co-op counts as an internship whatever its listing says.', 'bool', False),
    Setting('workers.high_volume_weekly', G_AUTO, 'Autoplay picks per busy company per week', 'His choice (2026-11-02): at a company with 5 or more open roles (normally left for you to pick), autoplay may still take its best-ranked reviewed fits, up to this many applications in any 7 days. Stated employer caps still apply. 0 leaves those companies entirely to you.', 'int', 2, 0, 20),
    Setting('workers.captcha_visible_handoff', G_AUTO, 'Open a visible Chrome when the CAPTCHA solver fails', 'His request (2026-11-01): when the CAPTCHA package cannot pass a challenge in the hidden relay Chrome, nothing is sent and a visible Chrome opens with the application filled in, for you to solve the CAPTCHA and press Submit. Off leaves the posting in Needs help for Finish in my Chrome.', 'bool', True),
    Setting('workers.stall_minutes', G_AUTO, 'Stop a worker stuck this many minutes', 'A worker whose progress has not changed for this long while working is stopped and the role ends as interrupted (cooldown and retry rules then apply). Hand-offs to you, approvals and submissions are never stopped. 0 turns it off.', 'int', 30, 0, 600),
    Setting('workers.max_steps', G_AUTO, 'Page steps per application', 'A worker gives up after this many actions on one application.', 'int', 60, 10, 200),
    Setting('workers.resume_tailoring', G_AUTO, 'Tailor the resume to each posting before applying', 'A model reads each posting against your standing resume and the tailored copies you approved (application-agent private/resumes). A saved copy that suits it is used; otherwise it drafts a tailored resume in your exact layout and the role waits on Approvals until you approve, edit or decline it. A failed check uses your standing resume.', 'bool', True),
    Setting('workers.resume_tailoring_approval', G_AUTO, 'Ask before using a tailored resume', 'Off (his choice, 2026-10-23): a tailored draft that fits one page is used without review, and the exact resume each application uploads is kept with the posting. On: drafts wait on Approvals.', 'bool', False),
    Setting('workers.resume_review_model', G_AUTO, 'Resume tailoring model', 'Claude model used through the CLI on your plan to pick or draft the resume; a second model then rewords the draft.', 'choice', 'sonnet', choices=MODELS),
    Setting('workers.resume_reword_engine', G_AUTO, 'Resume reword engine', 'A different model rewrites the tailored draft\'s wording with the same facts and keywords. Codex falls back to OpenCode when it fails; the reword is used only if it still fits one page and keeps the posting keywords. Off sends the draft as written.', 'choice', 'codex', choices=('codex', 'opencode', 'off')),
    Setting('workers.resume_reword_codex_model', G_AUTO, 'Resume reword Codex model', 'Empty uses the Codex CLI default.', 'text', ''),
    Setting('workers.resume_reword_opencode_model', G_AUTO, 'Resume reword OpenCode model', 'provider/model, e.g. a free opencode/... model from `opencode models`.', 'text', 'opencode/beam-free'),
    Setting('workers.resume_review_timeout_seconds', G_AUTO, 'Resume tailoring timeout (seconds)', 'Per posting; drafting a full tailored resume takes a few minutes.', 'int', 600, 60, 1800),
    Setting('workers.learned_drafts', G_AUTO, 'Draft written answers from your edits', 'Each written question on Approvals is drafted by a model from the posting, your experience, your approved answers and a style guide learned from how you edit drafts (application-agent private/writing-style.md). Drafts are review-only.', 'bool', True),
    Setting('workers.writing_model', G_AUTO, 'Writing model', 'Claude model used through the CLI on your plan for drafts and the style guide.', 'choice', 'opus', choices=MODELS),
    Setting('assistant.model', G_AUTO, 'Dashboard assistant model', 'Claude model, through the CLI on your plan, for the chat on the front page. It has full permissions on this Mac except changing JobAgent and the application agent themselves.', 'choice', 'sonnet', choices=MODELS),
    Setting('workers.manual_companies', G_AUTO, 'Companies you apply to yourself', 'Employers never applied to automatically, comma-separated (a name matches any company containing it, so "TikTok" covers TikTok USDS JV). Their postings stay listed and ranked; autoplay skips them and queueing one is refused.', 'text', ''),
    Setting('workers.blocked_hosts', G_AUTO, 'Sites that refuse the worker\'s browser', 'Hosts, comma-separated (tesla.com covers www.tesla.com), whose postings are never launched: queueing one or autoplay reaching it puts it on the Apply yourself list with its tailored resume. Hosts are added automatically when they deny access repeatedly (below).', 'text', ''),
    Setting('workers.real_chrome_hosts', G_AUTO, 'Sites filled in the hidden real Chrome', 'His choice (2026-11-10): hosts, comma-separated (tesla.com covers www.tesla.com), whose postings run in the hidden relay Chrome (a real Chrome, which Tesla\'s Akamai edge lets through) instead of the headless browser it refuses. Submitted automatically like any other run.', 'text', 'tesla.com'),
    Setting('workers.visible_hosts', G_AUTO, 'Sites opened in your visible Chrome', 'His choice (2026-11-10): hosts, comma-separated, whose postings open straight in Finish in my Chrome, because a CAPTCHA there (Rivian\'s iCIMS login hCaptcha) needs you: you pass the CAPTCHA, the form is filled, and you submit.', 'text', 'us-careers-rivian.icims.com, careers.rivian.com'),
    Setting('workers.blocked_host_denials', G_AUTO, 'Access-denied postings before a site is added to that list', 'When a site answers access denied / HTTP 403 on this many different postings in a row, it joins the sites that refuse the browser, with the date and reason recorded. 0 turns it off.', 'int', 3, 0, 20),
    Setting('workers.max_runs_without_progress', G_AUTO, 'Runs without progress before a role stops retrying', 'A role whose runs keep ending the same way (same error, same page, nothing new answered or flagged) goes to Needs help after this many, and no automatic retry, cool-down or breaker retry starts it again. Your Try again on the dashboard or queueing it again resets the count; a repair agent\'s retry gets one more run, which must show progress. 0 turns it off.', 'int', 3, 0, 20),
    Setting('workers.platform_yield_days', G_AUTO, 'Days of history for each platform\'s submit rate', 'Autoplay ranks hiring platforms (Workday, Greenhouse, Oracle Cloud, ...) by how often their postings ended in an automatic submission over this many days.', 'int', 21, 3, 120),
    Setting('workers.platform_yield_min_jobs', G_AUTO, 'Postings needed before a platform\'s rate counts', 'Below this many postings in the window a platform is neutral: no ranking change and never held.', 'int', 5, 1, 100),
    Setting('workers.autoplay_min_platform_success', G_AUTO, 'Lowest platform submit rate autoplay takes', 'Autoplay leaves platforms below this automatic-submit rate (with enough postings) to you; roles you queue yourself are never held. 0 turns the hold off.', 'float', 0.25, 0, 1),
    Setting('workers.autoplay_platform_weight', G_AUTO, 'Priority points for a platform\'s submit rate', 'Autoplay adds this many points times (rate - 0.5) to a posting\'s 0-100 priority, so higher-yield platforms come first. 0 ranks by priority alone.', 'float', 20, 0, 100),
    Setting('workers.rate_limit_cooldowns', G_AUTO, 'Cool-downs after rate limiting (minutes)', 'Successive waits before an employer that rate-limited us is tried again; after the last, the role goes to Needs help.', 'minutes_list', [45, 180, 720]),

    # Pruning (processing/track_eval.py)
    Setting('pruning.enabled', G_PRUNE, 'Remove postings no track accepts', 'Off: they are stored and shown as before.', 'bool', True),
    Setting('maintenance.snapshots_per_job', G_PRUNE, 'Posting copies kept per job', 'Each scan that changes a posting stores a copy; older copies beyond this are removed as they are written and on the weekly Sunday clean-up, which also compacts the database file.', 'int', 3, 1, 50),
    Setting('pruning.include_likely_ineligible', G_PRUNE, 'Also remove "likely ineligible"', 'Senior titles and too many required years. Off: only outright ineligible postings are removed.', 'bool', True),

    # Discovery & sources
    Setting('search.discovery_interval_minutes', G_DISCOVERY, 'Minutes between scans', 'How often every source is scanned.', 'float', None, 5, 1440, config=('search.yaml', 'cadence', 'discovery_interval_minutes'), applies='after the dashboard restarts'),
    Setting('search.verify_per_scan', G_DISCOVERY, 'Open postings checked per scan', 'After each scan, how many open postings the scan did not list are checked on the employer site. A posting closes when two checks in a row find it removed. 0 turns the check off.', 'int', 1500, 0, 10000),
    Setting('search.verify_minutes', G_DISCOVERY, 'Posting check time limit (minutes)', 'The longest the check after a scan may run.', 'float', 20, 1, 240),
    Setting('scraping.direct_detail_limit', G_DISCOVERY, 'Postings opened per career site', 'Direct company career pages: how many postings are opened for their full text per scan.', 'int', 25, 0, 200),
    Setting('sources.research_candidates', G_DISCOVERY, 'Job boards proposed per company', 'When you add a source by name, how many candidate boards the agent proposes.', 'int', 3, 1, 10),
    Setting('sources.research_timeout_seconds', G_DISCOVERY, 'Source research timeout (seconds)', 'How long the agent may search the web for a board.', 'int', 300, 30, 1200),

    # Email job alerts (discovery/email_alerts.py)
    Setting('email.enabled', G_EMAIL, 'Read job-alert emails', 'Collect postings from LinkedIn, Handshake, ZipRecruiter and similar alert emails in your inbox.', 'bool', True),
    Setting('email.scan_interval_minutes', G_EMAIL, 'Minutes between inbox checks', '', 'float', 60, 10, 1440, applies='after the dashboard restarts'),
    Setting('email.senders', G_EMAIL, 'Alert senders (Gmail search)', 'Addresses or domains whose emails are job alerts, joined with OR.', 'text', ALERT_SENDERS),
    Setting('email.lookback_days', G_EMAIL, 'Days of email read on the first check', 'Later checks read what arrived since the previous one.', 'int', 3, 1, 30),
    Setting('email.max_emails_per_run', G_EMAIL, 'Alert emails read per check', 'The rest wait for the next check.', 'int', 15, 1, 100),
    Setting('email.max_agent_searches_per_run', G_EMAIL, 'Agent searches per check', 'Postings whose link needs a login (LinkedIn, Handshake) are found on the employer site by an agent; this caps how many per check.', 'int', 15, 0, 200),
    Setting('email.reader_model', G_EMAIL, 'Model that reads the emails', 'Claude model used through the CLI on your plan.', 'choice', 'sonnet', choices=MODELS),
    Setting('email.search_model', G_EMAIL, 'Model that searches for postings', 'Claude model used through the CLI on your plan.', 'choice', 'sonnet', choices=MODELS),
    Setting('email.timeout_seconds', G_EMAIL, 'Timeout per agent call (seconds)', '', 'int', 600, 60, 1800),

    # Indeed (discovery/indeed.py)
    Setting('indeed.enabled', G_INDEED, 'Search Indeed', "Read Indeed postings through the Indeed app's job-search API (the website blocks automated browsers). Only postings with the employer's own apply link are kept; the queries are in config/search.yaml.", 'bool', True),
    Setting('indeed.scan_interval_minutes', G_INDEED, 'Minutes between Indeed searches', 'Indeed is searched inside the regular scan, at most this often.', 'float', 360, 15, 1440),
    Setting('indeed.hours_old', G_INDEED, 'Newest postings only (hours)', 'Only postings Indeed dated within this window are read.', 'int', 168, 24, 720),
    Setting('indeed.results_per_query', G_INDEED, 'Results read per query', 'Indeed answers up to 100 per page; more means more pages per query.', 'int', 100, 10, 500),
    Setting('indeed.request_pause_seconds', G_INDEED, 'Seconds between Indeed requests', '', 'float', 1.0, 0, 30),
    Setting('indeed.cooldown_hours', G_INDEED, 'Hours to pause after a refusal', 'After Indeed answers HTTP 403 or 429, no Indeed request is made for this long.', 'float', 6, 0.5, 168),
    Setting('indeed.resolve_leads', G_INDEED, 'Find employer links on Indeed for LinkedIn and alert-email postings', "A posting that only names a company and title (LinkedIn search, LinkedIn/Handshake/ZipRecruiter alert emails) is looked up on Indeed, whose results carry the employer's apply link, before the slower web-search agent.", 'bool', True),
    Setting('indeed.lead_lookups_per_run', G_INDEED, 'Indeed lookups per run', 'Cap on such lookups in one LinkedIn search or one inbox check (about one request a second).', 'int', 300, 0, 1000),

    # LinkedIn (discovery/linkedin.py)
    Setting('linkedin.enabled', G_LINKEDIN, 'Search LinkedIn', "Read LinkedIn's public job search (no account). Each result is a lead: the posting is then found on Indeed or by the web-search agent, since LinkedIn shows visitors no employer link. The queries are in config/search.yaml.", 'bool', True),
    Setting('linkedin.scan_interval_minutes', G_LINKEDIN, 'Minutes between LinkedIn searches', 'LinkedIn is searched inside the regular scan, at most this often.', 'float', 360, 15, 1440),
    Setting('linkedin.hours_old', G_LINKEDIN, 'Newest postings only (hours)', 'Only postings LinkedIn dated within this window are read.', 'int', 168, 24, 720),
    Setting('linkedin.results_per_query', G_LINKEDIN, 'Results read per query', 'LinkedIn answers 10 per page; more means more pages per query.', 'int', 25, 10, 100),
    Setting('linkedin.request_pause_seconds', G_LINKEDIN, 'Seconds between LinkedIn requests', 'LinkedIn throttles quick requests.', 'float', 4, 0, 30),
    Setting('linkedin.cooldown_hours', G_LINKEDIN, 'Hours to pause after a refusal', 'After LinkedIn answers HTTP 403 or 429, no LinkedIn request is made for this long.', 'float', 6, 0.5, 168),
    Setting('linkedin.max_agent_searches_per_run', G_LINKEDIN, 'Agent searches per run', 'Leads Indeed does not carry are found on the employer site by the web-search agent (Claude CLI on your plan); this caps how many per run. The rest wait for the next run.', 'int', 5, 0, 100),

    # Handshake (discovery/handshake.py)
    Setting('handshake.enabled', G_HANDSHAKE, 'Search Handshake', "Read Handshake's job search with your own signed-in browser session (sign in once with `jobagent handshake-login`). Postings that apply on the employer's site are kept; Handshake-only ones are found on Indeed or by the web-search agent. The queries are in config/search.yaml.", 'bool', True),
    Setting('handshake.scan_interval_minutes', G_HANDSHAKE, 'Minutes between Handshake searches', 'Handshake is searched inside the regular scan, at most this often.', 'float', 360, 15, 1440),
    Setting('handshake.hours_old', G_HANDSHAKE, 'Newest postings only (hours)', 'Results come newest first; reading stops at the first posting older than this.', 'int', 336, 24, 720),
    Setting('handshake.results_per_query', G_HANDSHAKE, 'Results read per query', 'Newest first, 25 per page.', 'int', 50, 10, 300),
    Setting('handshake.request_pause_seconds', G_HANDSHAKE, 'Seconds between Handshake pages', '', 'float', 3, 0, 30),
    Setting('handshake.cooldown_hours', G_HANDSHAKE, 'Hours to pause after a refusal', 'After Handshake refuses a request or signs the session out.', 'float', 6, 0.5, 168),
    Setting('handshake.max_agent_searches_per_run', G_HANDSHAKE, 'Agent searches per run', 'Handshake-only postings Indeed does not carry are found on the employer site by the web-search agent; this caps how many per run.', 'int', 5, 0, 100),
    Setting('handshake.login_timeout_minutes', G_HANDSHAKE, 'Minutes to wait for the sign-in', 'How long the sign-in window stays open for you.', 'float', 10, 1, 60),

    # Application worker (application-agent src/dashboard-worker.mjs)
    Setting('worker.site_hints', G_WORKER, 'Learn hints about each application site', 'After a run, the run\'s own model notes durable, non-personal knowledge about the site (where controls hide, waits, traps); later steps on that site see the best notes. Notes gain or lose a point with each submit or failure and retire at -3.', 'bool', True, used_by='application-agent'),
    Setting('worker.lean_steps', G_WORKER, 'Lean page steps', 'Each page step is a tool-free model call (no tools, MCP servers or settings files): about a tenth of the tokens of a full agent session. A run that gets stuck (two refused actions, or one action three times) gets the full agent back for its next steps. Off: every step is a full agent session.', 'bool', True, used_by='application-agent'),
    Setting('worker.step_timeout_seconds', G_WORKER, 'Seconds the model has per page step', 'The CLI call that decides each action.', 'int', 180, 30, 900, used_by='application-agent'),
    Setting('worker.direct_control_timeout_seconds', G_WORKER, 'Seconds a direct-control session may take per page', 'One Claude session filling a whole form page; when it runs out the worker continues step by step.', 'int', 300, 60, 900, used_by='application-agent'),
    Setting('worker.direct_control_min_open', G_WORKER, 'Open required questions before direct control starts', 'A session takes about 8 seconds to start, so pages with fewer open required questions stay with the step loop.', 'int', 3, 1, 20, used_by='application-agent'),
    Setting('worker.max_rejected_steps', G_WORKER, 'Unusable model steps before giving up', 'Steps naming a control that is not on the page, or one it may not use.', 'int', 5, 1, 30, used_by='application-agent'),
    Setting('worker.max_sign_in_attempts', G_WORKER, 'Sign-in attempts per site', 'Before the role goes to Needs help.', 'int', 5, 1, 20, used_by='application-agent'),

    # Workday runner (application-agent tools/workday-run.mjs, src/workday-mail.mjs, src/throttle.mjs)
    Setting('workday.max_wizard_steps', G_WORKDAY, 'Wizard pages per run', 'A Workday run stops after this many pages.', 'int', 16, 4, 60, used_by='application-agent'),
    Setting('workday.stuck_limit', G_WORKDAY, 'Times a page may not advance', 'Before the run stops as blocked.', 'int', 2, 1, 10, used_by='application-agent'),
    Setting('workday.sign_in_form_tries', G_WORKDAY, 'Tries to open the sign-in form', 'Some tenants hide it behind several buttons.', 'int', 8, 1, 30, used_by='application-agent'),
    Setting('workday.mail_lookup_tries', G_WORKDAY, 'Mailbox checks for a verification email', 'After a resend, how many times the mailbox is checked.', 'int', 4, 1, 20, used_by='application-agent'),
    Setting('workday.mail_wait_seconds', G_WORKDAY, 'Seconds between mailbox checks', '', 'int', 30, 5, 600, used_by='application-agent'),
    Setting('workday.mail_freshness_hours', G_WORKDAY, 'Oldest usable verification email (hours)', 'Workday links expire after 24 hours.', 'float', 23, 1, 24, used_by='application-agent'),
    Setting('workday.mail_model', G_WORKDAY, 'Model that reads the mailbox', 'Claude model used through the CLI on your plan.', 'choice', 'haiku', choices=MODELS, used_by='application-agent'),
    Setting('throttle.refresh_pause_seconds', G_WORKDAY, 'Pause before refreshing an error page (seconds)', 'An employer error page is refreshed once after this pause; if it stays, the role cools down.', 'int', 20, 0, 300, used_by='application-agent'),
]
BY_KEY = {s.key: s for s in REGISTRY}
MODEL_IDS = {'haiku': 'claude-haiku-4-5-20251001', 'sonnet': 'sonnet', 'opus': 'opus'}


def settings_path() -> Path:
    from .config import get_settings
    return get_settings().data_dir / 'settings.json'


_cache = {'stamp': None, 'overrides': {}}


def overrides() -> dict:
    path = settings_path()
    try:
        stamp = path.stat().st_mtime
    except OSError:
        return {}
    if _cache['stamp'] != stamp:
        try:
            _cache['overrides'] = json.loads(path.read_text()).get('overrides', {})
        except (OSError, ValueError):
            _cache['overrides'] = {}
        _cache['stamp'] = stamp
    return _cache['overrides']


def _config_default(s: Setting):
    import yaml
    from .config import config_path
    value = yaml.safe_load(config_path(s.config[0]).read_text())
    for part in s.config[1:]:
        value = (value or {}).get(part)
    return value


def default(key):
    s = BY_KEY[key]
    return _config_default(s) if s.config else s.default


def setting(key):
    """The effective value of a setting: his override, else the default."""
    if key not in BY_KEY:
        raise KeyError(key)
    found = overrides()
    return found[key] if key in found else default(key)


def model_id(key):
    return MODEL_IDS.get(setting(key), setting(key))


def coerce(s: Setting, value):
    if s.type == 'bool':
        if isinstance(value, str):
            return value.strip().lower() in ('1', 'true', 'yes', 'on')
        return bool(value)
    if s.type == 'choice':
        if value not in s.choices:
            raise ValueError(f'{s.label}: choose one of {", ".join(s.choices)}')
        return value
    if s.type == 'text':
        value = str(value).strip()
        if not value and s.default:
            raise ValueError(f'{s.label}: cannot be empty')
        return value
    if s.type == 'minutes_list':
        items = value if isinstance(value, list) else [v for v in str(value).replace(' ', '').split(',') if v]
        items = [float(v) for v in items]
        if not items or any(v <= 0 for v in items):
            raise ValueError(f'{s.label}: give one or more positive numbers of minutes')
        return items
    number = int(value) if s.type == 'int' else float(value)
    if s.min is not None and number < s.min or s.max is not None and number > s.max:
        raise ValueError(f'{s.label}: must be between {s.min:g} and {s.max:g}')
    return number


def describe():
    """Every setting with its metadata, default and current value, grouped for the dashboard."""
    found = overrides()
    out = []
    for s in REGISTRY:
        d = default(s.key)
        out.append({'key': s.key, 'group': s.group, 'label': s.label, 'help': s.help, 'type': s.type, 'min': s.min, 'max': s.max,
                    'choices': list(s.choices), 'default': d, 'value': found.get(s.key, d), 'changed': s.key in found,
                    'applies': s.applies, 'used_by': s.used_by})
    return out


def save(changes: dict, reset=()):
    """Validate and store his changes; returns the keys whose value actually changed."""
    current = dict(overrides())
    changed = []
    for key, value in (changes or {}).items():
        if key not in BY_KEY:
            raise ValueError(f'Unknown setting: {key}')
        value = coerce(BY_KEY[key], value)
        if value == default(key):
            if current.pop(key, None) is not None:
                changed.append(key)
        elif current.get(key) != value:
            current[key] = value
            changed.append(key)
    for key in reset:
        if current.pop(key, None) is not None:
            changed.append(key)
    write(current)
    return changed


def write(current=None):
    """Store overrides plus the effective value of every setting (read by the application agent)."""
    current = overrides() if current is None else current
    effective = {s.key: current.get(s.key, default(s.key)) for s in REGISTRY}
    path = settings_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.tmp')
    tmp.write_text(json.dumps({'overrides': current, 'effective': effective, 'models': MODEL_IDS}, indent=2))
    tmp.replace(path)
    _cache['stamp'] = None


def apply_config_overrides(filename: str, data: dict) -> dict:
    """Overlay his settings onto a YAML config as it is loaded."""
    found = overrides()
    for s in REGISTRY:
        if s.config and s.config[0] == filename and s.key in found:
            node = data
            for part in s.config[1:-1]:
                node = node.setdefault(part, {})
            node[s.config[-1]] = found[s.key]
    return data

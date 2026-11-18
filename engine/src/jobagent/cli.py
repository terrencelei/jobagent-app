import json
import os
from pathlib import Path
import re
import shutil
import subprocess
from datetime import datetime, timezone, timedelta
from typing import Optional
import typer
from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from sqlalchemy import or_, and_

from .config import get_settings
from .db.models import EligibilityStatus, Job, JobStatus, utc_now
from .db.repository import JobRepository, get_db_session, init_db
from .discovery.search_agent import SearchAgent
from .services.scheduler import RefreshScheduler
from .tracking.applications import ApplicationTracker
from .tracking.lifecycle import JobLifecyclePipeline
from .ui.server import run_server
from .ui.exporter import export_static_dashboard
from .ui.dashboard import dashboard_counts, APPLICABLE
from .agents.job_agent import JobAgentAssistant
from . import identity

app = typer.Typer(help="JobAgent: AI-assisted job discovery, ranking, and tracking system.")
console = Console()


@app.command()
def init():
    """Initialize database, seed candidate profile, facts, and target companies."""
    console.print("[bold cyan]Initializing JobAgent database and candidate facts...[/bold cyan]")
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)
        counts = repo.get_status_counts()
        facts_count = len(repo.get_candidate_facts())
    console.print(f"[bold green]✓[/bold green] Database initialized successfully.")
    console.print(f"[bold green]✓[/bold green] Candidate facts loaded: [cyan]{facts_count}[/cyan] verified entries.")
    console.print(f"[bold green]✓[/bold green] Target companies seeded in catalog.")


@app.command()
def doctor():
    """Check the prerequisites for the selected Application Agent model without starting workers."""
    settings = get_settings()
    runner_dir = Path(settings.data_dir) / 'application-runner'
    queue_path = runner_dir / 'queue.json'
    try:
        queue = json.loads(queue_path.read_text())
    except (OSError, ValueError):
        queue = {}

    engine = queue.get('engine') or 'claude'
    model = queue.get('model') or {
        'claude': 'claude-sonnet-5-5', 'codex': 'CLI default',
        'opencode': 'CLI default', 'agy': 'configured model order',
    }.get(engine, 'unknown')
    agent_dir = _agent_dir()
    profile_path = agent_dir / 'private/profile.json'
    worker_path = agent_dir / 'src/dashboard-worker.mjs'
    playwright_path = agent_dir / 'node_modules/playwright/package.json'
    checks = []

    def add(label, ok, detail):
        checks.append((label, bool(ok), detail))

    node = shutil.which('node')
    add('Node.js', node, node or 'Not found on PATH')
    add('Application Agent worker', worker_path.is_file(), 'Found' if worker_path.is_file() else f'Missing {worker_path}')
    add('Playwright package', playwright_path.is_file(), 'Installed' if playwright_path.is_file() else 'Not installed in application-agent')

    profile = {}
    try:
        profile = json.loads(profile_path.read_text())
    except (OSError, ValueError):
        pass
    add('Application profile', bool(profile), 'Loaded' if profile else 'Missing or unreadable private/profile.json')
    resume = agent_dir / str(profile.get('resumePath') or f'private/{identity.resume_filename()}')
    add('Resume file', resume.is_file(), 'Available' if resume.is_file() else 'Missing the profile resume file')

    cli_name = {'claude': 'claude', 'codex': 'codex', 'opencode': 'opencode', 'agy': 'agy'}.get(engine)
    cli = shutil.which(cli_name) if cli_name else None
    if cli_name and not cli:
        cli = next((str(path) for path in (
            Path.home() / '.local/bin' / cli_name,
            Path('/opt/homebrew/bin') / cli_name,
            Path('/usr/local/bin') / cli_name,
        ) if path.is_file() and os.access(path, os.X_OK)), None)
    add(f'{engine} CLI', cli, cli or f'{cli_name or engine} was not found')

    if cli:
        try:
            if engine in {'claude', 'codex'}:
                env = {k: v for k, v in os.environ.items() if k not in {
                    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'CODEX_API_KEY', 'ANTHROPIC_AUTH_TOKEN'}}
                args = [cli, 'auth', 'status'] if engine == 'claude' else [cli, 'login', 'status']
                result = subprocess.run(args, capture_output=True, text=True, timeout=20, env=env)
                add(f'{engine} sign-in', result.returncode == 0,
                    'Signed in' if result.returncode == 0 else 'Not signed in; run the CLI sign-in command')
            elif engine == 'opencode':
                result = subprocess.run([cli, 'models'], capture_output=True, text=True, timeout=20)
                models = [line.strip() for line in result.stdout.splitlines() if '/' in line]
                ready = result.returncode == 0 and bool(models)
                add('OpenCode model catalog', ready, f'{len(models)} model(s) available' if ready else 'No models available')
                add('Selected model', model in models, 'Available' if model in models else f'{model} is not in the current catalog')
            elif engine == 'agy':
                result = subprocess.run([cli, 'models'], capture_output=True, text=True, timeout=30)
                models = [line for line in result.stdout.splitlines() if '\t' in line]
                ready = result.returncode == 0 and bool(models)
                add('agy model catalog', ready, f'{len(models)} model(s) available' if ready else 'No models available; sign in to agy')
        except (OSError, subprocess.SubprocessError) as exc:
            add(f'{engine} readiness', False, f'Could not check CLI readiness ({type(exc).__name__})')

    table = Table(title=f'Application Agent preflight · {engine} · {model}')
    table.add_column('Check')
    table.add_column('Status')
    table.add_column('Details')
    for label, ok, detail in checks:
        table.add_row(label, '[green]Ready[/green]' if ok else '[red]Needs attention[/red]', detail)
    console.print(table)
    if not all(ok for _, ok, _ in checks):
        raise typer.Exit(code=1)


@app.command()
def search(
    company: Optional[str] = typer.Option(None, "--company", "-c", help="Search specific company only"),
    limit_sources: Optional[int] = typer.Option(None, "--limit", "-l", help="Limit number of sources to scan"),
    github_only: bool = typer.Option(False, "--github-only", help="Scan configured GitHub job repositories only"),
    indeed_only: bool = typer.Option(False, "--indeed-only", help="Search Indeed now through the app API, whatever the interval"),
    only: Optional[str] = typer.Option(None, "--only", help="Scan one channel only, now: github, indeed, linkedin or handshake"),
):
    """Run multi-path job discovery across target ATS boards and company career sites."""
    if (github_only or indeed_only or only) and company:
        raise typer.BadParameter("--github-only/--indeed-only/--only cannot be combined with --company")
    if only and only not in ('github', 'indeed', 'linkedin', 'handshake'):
        raise typer.BadParameter("--only takes github, indeed, linkedin or handshake")
    init_db()
    console.print("[bold cyan]Running discovery search across configured sources...[/bold cyan]")

    with get_db_session() as session:
        agent = SearchAgent(session)
        stats = agent.run_discovery(specific_company=company, max_sources=limit_sources, github_only=github_only, indeed_only=indeed_only, only=only)

    # Render Section 32 Observability Report
    console.print()
    panel_content = (
        f"[bold white]Sources checked:[/bold white]      [cyan]{stats['sources_checked']}[/cyan]\n"
        f"[bold white]Jobs scanned:[/bold white]         [cyan]{stats['jobs_scanned']}[/cyan]\n"
        f"[bold white]New jobs:[/bold white]             [green]{stats['new_jobs']}[/green]\n"
        f"[bold white]Updated:[/bold white]              [yellow]{stats['updated_jobs']}[/yellow]\n"
        f"[bold white]Duplicates merged:[/bold white]    [blue]{stats['duplicates_merged']}[/blue]\n"
        f"[bold white]Closed:[/bold white]               [dim]{stats['closed_jobs']}[/dim]\n"
        f"[bold white]Errors:[/bold white]               [red]{stats['errors_count']}[/red]\n\n"
        f"[bold white]High-fit new jobs:[/bold white]    [bold magenta]{stats['high_fit_new_jobs']}[/bold magenta]\n"
        f"[bold white]{identity.grad_timing().year}/New Grad jobs:[/bold white]   [bold green]{stats['new_grad_jobs']}[/bold green]"
    )

    if stats.get("top_match_title"):
        panel_content += (
            f"\n\n[bold yellow]TOP NEW MATCH[/bold yellow]\n"
            f"[bold white]{stats['top_match_title']}[/bold white] at [cyan]{stats['top_match_company']}[/cyan]\n"
            f"Priority Score: [bold green]{stats['top_match_score']:.1f}[/bold green]"
        )

    console.print(Panel(panel_content, title="[bold cyan]SEARCH COMPLETE[/bold cyan]", border_style="cyan"))


@app.command()
def refresh(
    max_check: int = typer.Option(50, "--max-check", "-m", help="Max jobs to verify status for"),
):
    """Verify status of active jobs and detect closed postings."""
    init_db()
    console.print("[bold cyan]Verifying active listing statuses...[/bold cyan]")
    with get_db_session() as session:
        pipeline = JobLifecyclePipeline(session)
        closed_count = pipeline.verify_active_jobs(max_check=max_check)
    console.print(f"[bold green]✓[/bold green] Status verification complete. [dim]{closed_count} closed listings detected.[/dim]")


@app.command()
def jobs(
    top: int = typer.Option(20, "--top", "-t", help="Number of jobs to display"),
    new: bool = typer.Option(False, "--new", "-n", help="Show only new listings"),
    new_grad: bool = typer.Option(False, "--new-grad", help="Filter for New Grad / University Graduate roles in your graduation year"),
    min_score: Optional[float] = typer.Option(None, "--min-score", "-s", help="Filter by minimum priority score"),
    cluster: Optional[str] = typer.Option(None, "--cluster", help="Filter by career cluster keyword (e.g. product, robotics, aerospace)"),
    company: Optional[str] = typer.Option(None, "--company", "-c", help="Filter by company name"),
    sort: str = typer.Option("priority", "--sort", help="Sort by 'priority', 'relevance', 'urgency', or 'newest'"),
):
    """List ranked opportunities with scores, career clusters, and eligibility."""
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)

        # Normalize cluster filter
        cluster_target = None
        if cluster:
            c_low = cluster.lower()
            if "product" in c_low or "mechanical" in c_low:
                cluster_target = "PRODUCT / MECHANICAL DESIGN"
            elif "robot" in c_low or "mechatron" in c_low:
                cluster_target = "ROBOTICS / MECHATRONICS"
            elif "hardware" in c_low or "system" in c_low:
                cluster_target = "HARDWARE / SYSTEMS"
            elif "manufactur" in c_low or "automation" in c_low:
                cluster_target = "MANUFACTURING / EQUIPMENT / AUTOMATION"
            elif "aero" in c_low or "vehicle" in c_low:
                cluster_target = "AEROSPACE / VEHICLE"
            elif "tpm" in c_low or "program" in c_low:
                cluster_target = "TECHNICAL PROGRAM MANAGEMENT"
            elif "data" in c_low or "analytic" in c_low:
                cluster_target = "DATA / ENGINEERING ANALYTICS"

        job_list = repo.list_jobs(
            statuses=[JobStatus.NEW] if new else [JobStatus.NEW, JobStatus.ACTIVE],
            min_priority=min_score,
            career_cluster=cluster_target,
            company_name=company,
            new_grad_only=new_grad,
            eligibilities=list(APPLICABLE),
            role_types=["FULL_TIME"],
            sort_by=sort,
            limit=top,
        )

        if not job_list:
            console.print("[yellow]No matching opportunities found. Try relaxing filters or running `jobagent search`.[/yellow]")
            return

        table = Table(title=f"Top {len(job_list)} Engineering Opportunities (Sort: {sort.upper()})", border_style="cyan")
        table.add_column("ID", style="dim", width=5)
        table.add_column("Company", style="bold cyan")
        table.add_column("Title", style="white")
        table.add_column("Cluster", style="magenta")
        table.add_column("Location", style="dim")
        table.add_column("Prio", justify="right", style="bold green")
        table.add_column("Rel", justify="right", style="blue")
        table.add_column("Urg", justify="right", style="yellow")
        table.add_column("Eligibility", style="italic")

        now = utc_now()
        for j in job_list:
            el_style = "[green]STRONG[/green]" if j.eligibility.value == "STRONG_MATCH" else (
                "[red]CONFLICT[/red]" if j.eligibility.value == "POSSIBLE_CONFLICT" else "[blue]ELIGIBLE[/blue]"
            )
            table.add_row(
                str(j.id),
                j.company_name[:18],
                j.title[:36],
                (j.best_career_cluster or "")[:20],
                (j.location or "United States")[:16],
                f"{j.priority_score:.1f}",
                f"{j.relevance_score:.1f}",
                f"{j.urgency_score:.1f}",
                el_style,
            )

        console.print(table)


@app.command()
def status():
    """Display overall system metrics, active opportunities, and recruiting pipeline status."""
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)
        counts = dashboard_counts(session)
        active_count = counts['ACTIVE']
        saved_count = counts['SAVED']
        applied_count = counts['APPLIED']
        interview_count = counts['INTERVIEW']
        high_matches = counts['HIGH_MATCH']
        new_grad_matches = counts['NEW_GRAD']
        urgent_matches = counts['URGENT']
        new_today = counts['NEW_TODAY']
        now = utc_now()

        latest_run = repo.get_latest_search_run()
        last_disc_str = "None"
        if latest_run and latest_run.completed_at:
            if latest_run.completed_at.tzinfo is None:
                l_date = latest_run.completed_at.replace(tzinfo=timezone.utc)
            else:
                l_date = latest_run.completed_at
            diff_mins = int((now - l_date).total_seconds() / 60)
            last_disc_str = f"{diff_mins} minutes ago" if diff_mins < 60 else f"{int(diff_mins / 60)}h {diff_mins % 60}m ago"

    report = (
        f"[bold cyan]JOBAGENT STATUS OVERVIEW[/bold cyan]\n"
        f"Target: {identity.grad_timing().avail_label} early-career roles\n\n"
        f"Active opportunities:       [bold cyan]{active_count:>6}[/bold cyan]\n"
        f"New today:                  [green]{new_today:>6}[/green]\n"
        f"85+ matches:                [magenta]{high_matches:>6}[/magenta]\n"
        f"{identity.grad_timing().year}/New Grad:              [green]{new_grad_matches:>6}[/green]\n"
        f"Urgent:                     [yellow]{urgent_matches:>6}[/yellow]\n\n"
        f"Saved:                      [cyan]{saved_count:>6}[/cyan]\n"
        f"Applied:                    [bold green]{applied_count:>6}[/bold green]\n"
        f"Interviews:                 [bold yellow]{interview_count:>6}[/bold yellow]\n\n"
        f"Last discovery:             {last_disc_str}\n"
        f"Next discovery:             Scheduled (1h interval)"
    )
    console.print(Panel(report, border_style="cyan"))


@app.command()
def dismiss(
    identifier: str = typer.Argument(..., help="Job ID, or a title pattern with --pattern"),
    reason: str = typer.Option(..., "--reason", "-r", help="Why this is not worth applying to"),
    pattern: bool = typer.Option(False, "--pattern", help="Treat the argument as a title regex"),
    company: Optional[str] = typer.Option(None, "--company", help="Limit a pattern to one employer"),
):
    """Take a job off the dashboard and stop it being offered again.

    Judging a role unsuitable costs attention, so the judgement persists: the same req is
    rediscovered on the next scan, often at a new URL, and is dropped before ranking.
    """
    from .db.models import Job, JobStatus
    from .tracking.exclusions import add_exclusion, dismiss_job, matches, load_exclusions

    init_db()
    with get_db_session() as session:
        if pattern:
            add_exclusion(session, reason=reason, scope="title_pattern",
                          value=identifier, company_name=company)
            exclusions = load_exclusions(session)
            hit = [j for j in session.query(Job).filter(
                       Job.status.in_([JobStatus.NEW, JobStatus.ACTIVE])).all()
                   if matches(exclusions, title=j.title or "", company=j.company_name or "",
                              url=j.canonical_url or "")]
            for j in hit:
                j.status = JobStatus.IGNORED
            session.commit()
            console.print(f"[bold green]✓[/bold green] Pattern [cyan]{identifier}[/cyan] excluded; "
                          f"{len(hit)} open job(s) removed from the dashboard.")
            return
        job = session.query(Job).filter(Job.id == int(identifier)).first()
        if not job:
            raise typer.BadParameter(f"No job with id {identifier}")
        out = dismiss_job(session, job, reason)
        session.commit()
        console.print(f"[bold green]✓[/bold green] Dismissed #{out['job_id']} "
                      f"[cyan]{out['title']}[/cyan] at [white]{out['company']}[/white] "
                      f"[dim](matched on {out['scope']})[/dim]")


@app.command(name="reconcile-applications")
def reconcile_applications(
    receipts_file: str = typer.Argument(..., help="JSON array of employer receipts (company, title, receivedAt, sender)"),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report matches without changing anything"),
):
    """Mark jobs applied from employer acknowledgement emails.

    Applications are submitted from many places, so the queue goes stale unless the
    employer's own receipt is treated as the record. Reads receipts already fetched from
    the mailbox; no mail credential is used here.
    """
    import json as _json
    from .tracking.email_reconcile import reconcile

    receipts = _json.loads(Path(receipts_file).read_text())
    init_db()
    with get_db_session() as session:
        result = reconcile(session, receipts, apply=not dry_run)
    verb = "Would mark" if dry_run else "Marked"
    console.print(f"[bold green]{verb} {len(result['matched'])} job(s) as applied.[/bold green]")
    for m in result["matched"]:
        console.print(f"  #{m['job_id']:<5} {m['company']} — {m['title']}  [dim](match {m['score']}, was {m['was'].split('.')[-1]})[/dim]")
    if result.get("review"):
        console.print(f"[cyan]{len(result['review'])} receipt(s) look close but need your confirmation:[/cyan]")
        for r in result["review"]:
            console.print(f"  #{r['job_id']:<5} {r['company']}: receipt says [bold]{r['receipt_title']}[/bold], job is [bold]{r['job_title']}[/bold]  [dim](match {r['score']})[/dim]")
    if result["unmatched"]:
        console.print(f"[yellow]{len(result['unmatched'])} receipt(s) matched no open job:[/yellow]")
        for u in result["unmatched"]:
            console.print(f"  {u['company']} — {u['title'] or '(no title)'}")


@app.command()
def applied(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Optional notes on application"),
):
    """Mark a position as APPLIED and remove from recommendation queue."""
    init_db()
    with get_db_session() as session:
        tracker = ApplicationTracker(session)
        job = tracker.mark_applied(identifier=identifier, notes=notes)
    console.print(f"[bold green]✓[/bold green] Application logged permanently for [bold cyan]{job.title}[/bold cyan] at [bold white]{job.company_name}[/bold white].")


@app.command()
def interview(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Interview details"),
):
    """Move a position to INTERVIEW stage."""
    init_db()
    with get_db_session() as session:
        tracker = ApplicationTracker(session)
        job = tracker.update_stage(identifier=identifier, stage=JobStatus.INTERVIEW, notes=notes)
    console.print(f"[bold green]✓[/bold green] Marked Job #{job.id} as [bold yellow]INTERVIEW[/bold yellow].")


@app.command()
def offer(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Offer compensation / details"),
):
    """Move a position to OFFER stage."""
    init_db()
    with get_db_session() as session:
        tracker = ApplicationTracker(session)
        job = tracker.update_stage(identifier=identifier, stage=JobStatus.OFFER, notes=notes)
    console.print(f"[bold green]✓[/bold green] Congratulations! Marked Job #{job.id} as [bold green]OFFER[/bold green].")


@app.command()
def rejected(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
    notes: Optional[str] = typer.Option(None, "--notes", "-n", help="Rejection notes"),
):
    """Mark a position as REJECTED."""
    init_db()
    with get_db_session() as session:
        tracker = ApplicationTracker(session)
        job = tracker.update_stage(identifier=identifier, stage=JobStatus.REJECTED, notes=notes)
    console.print(f"[bold dim]Logged outcome for Job #{job.id} as REJECTED.[/bold dim]")


@app.command()
def save(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
):
    """Save a job for later review."""
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)
        job = repo.get_job_by_id(int(identifier)) if identifier.isdigit() else repo.get_job_by_canonical_url(identifier)
        if not job:
            console.print(f"[red]Job {identifier} not found.[/red]")
            return
        repo.set_job_status(job.id, JobStatus.SAVED)
    console.print(f"[bold green]✓[/bold green] Saved Job #{job.id} ({job.title} at {job.company_name}).")


@app.command()
def ignore(
    identifier: str = typer.Argument(..., help="Job ID or Job URL"),
):
    """Ignore a job and train preference model against similar listings."""
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)
        job = repo.get_job_by_id(int(identifier)) if identifier.isdigit() else repo.get_job_by_canonical_url(identifier)
        if not job:
            console.print(f"[red]Job {identifier} not found.[/red]")
            return
        repo.set_job_status(job.id, JobStatus.IGNORED)
    console.print(f"[dim]Job #{job.id} ignored and negative signal recorded.[/dim]")


@app.command()
def query(
    text: str = typer.Argument(..., help="Natural language query or update prompt"),
):
    """Natural language agent interface for queries and commands."""
    init_db()
    with get_db_session() as session:
        assistant = JobAgentAssistant(session)
        res = assistant.process_command(text)

    console.print(f"\n[bold cyan]Agent Response:[/bold cyan] {res.get('message') or res.get('action')}")
    results = res.get("results")
    if results:
        t = Table(border_style="cyan")
        t.add_column("ID", style="dim")
        t.add_column("Company", style="bold cyan")
        t.add_column("Title", style="white")
        t.add_column("Priority", justify="right", style="bold green")
        for r in results:
            t.add_row(str(r["id"]), r["company"], r["title"], f"{r['priority']:.1f}")
        console.print(t)


@app.command()
def daemon():
    """Run continuous background scheduler for automatic 1-hour discovery and verification."""
    init_db()
    console.print("[bold cyan]Starting JobAgent continuous background daemon...[/bold cyan]")
    console.print("[dim]Press Ctrl+C to stop.[/dim]")
    scheduler = RefreshScheduler(blocking=True)
    scheduler.start()


@app.command()
def export(
    open_browser: bool = typer.Option(False, "--open", "-o", help="Open exported dashboard webpage in default browser"),
):
    """Export current database to docs/index.html & docs/data.js for standalone browser viewing."""
    init_db()
    with get_db_session() as session:
        out_dir = export_static_dashboard(session)
    index_path = out_dir / "index.html"
    console.print(f"[bold green]✓[/bold green] Dashboard exported to: [cyan]{index_path}[/cyan]")
    console.print(f"[dim]You can keep [bold white]file://{index_path}[/bold white] open in your browser.[/dim]")
    if open_browser:
        import webbrowser
        webbrowser.open(f"file://{index_path}")


@app.command()
def serve(
    host: str = typer.Option("127.0.0.1", "--host", "-h", help="Server host"),
    port: int = typer.Option(8000, "--port", "-p", envvar="JOBAGENT_SERVER_PORT", help="Server port"),
):
    """Launch local web dashboard on http://127.0.0.1:8000 (or JOBAGENT_SERVER_PORT)."""
    init_db()
    console.print(f"[bold cyan]Launching JobAgent Dashboard on http://{host}:{port}...[/bold cyan]")
    run_server(host=host, port=port)


@app.command()
def reclassify():
    """Re-evaluate existing jobs with current profile/rules; preserve application history."""
    from .tracking.reclassify import reclassify_jobs
    init_db()
    from .processing.track_eval import prune_rejected
    with get_db_session() as session:
        changed = reclassify_jobs(session)
        removed = prune_rejected(session)
        export_static_dashboard(session)
    console.print(f"Updated classifications for {changed} postings; all scores refreshed. "
                  f"Removed {removed} postings no search track accepts.")


@app.command(name="email-alerts")
def email_alerts():
    """Read new job-alert emails and add their postings (found on the employer's site when needed)."""
    from .discovery.email_alerts import scan
    init_db()
    report = scan()
    console.print(json.dumps(report, indent=2, default=str))


@app.command(name="handshake-login")
def handshake_login(minutes: float = typer.Option(None, help="How long the window stays open (default: the setting)")):
    """Open a window on Handshake's sign-in; JobAgent keeps the session for its Handshake searches."""
    from .discovery.handshake import login
    ok, message = login(minutes, log=console.print)
    console.print(f"[green]{message}[/green]" if ok else f"[red]{message}[/red]")
    if not ok:
        raise typer.Exit(1)


@app.command(name="handshake-logout")
def handshake_logout():
    """Forget the saved Handshake browser session."""
    from .discovery.handshake import logout
    logout()
    console.print("Handshake session removed.")


@app.command(name="add-link")
def add_link(url: str, company: str = typer.Option(None, help="Employer, when the page does not say"),
             title: str = typer.Option(None, help="Posting title, when the page does not say"),
             location: str = typer.Option(None, help="U.S. work location, when the page does not say"),
             queue: bool = typer.Option(True, help="Queue it for application (--no-queue stores it only)"),
             next: bool = typer.Option(False, "--next", help="Queue it to play next instead of at the end")):
    """Add the posting at a link to JobAgent and queue it (reads the page in a headless browser)."""
    from .discovery.link_import import import_posting
    init_db()
    try:
        result = import_posting(url, {'company': company or '', 'title': title or '', 'location': location or ''}, queue, 'next' if next else 'end')
    except ValueError as exc:
        console.print(f"[red]{exc}[/red]")
        raise typer.Exit(1)
    console.print(json.dumps(result, indent=2, default=str))


@app.command()
def prune():
    """Delete stored postings that every search track rejects, keeping anything he has acted on."""
    from .processing.track_eval import prune_rejected
    init_db()
    with get_db_session() as session:
        removed = prune_rejected(session)
        export_static_dashboard(session)
    console.print(f"Removed {removed} postings no search track accepts.")


@app.command(name="export-queue")
def export_queue(
    output: Path = typer.Option(
        Path("agent/private/jobs.json"),
        "--output",
        "-o",
        help="Target output JSON path for application-agent",
    ),
    limit: int = typer.Option(20, "--limit", "-l", help="Number of opportunities to export"),
    min_priority: float = typer.Option(70.0, "--min-priority", "-p", help="Minimum priority score"),
    new_grad: bool = typer.Option(False, "--new-grad", help="Filter for New Grad positions in your graduation year"),
):
    """Export curated top-priority jobs into application-agent JSON format."""
    init_db()
    with get_db_session() as session:
        repo = JobRepository(session)
        job_list = repo.list_jobs(
            statuses=[JobStatus.NEW, JobStatus.ACTIVE],
            min_priority=min_priority,
            new_grad_only=new_grad,
            eligibilities=list(APPLICABLE),
            role_types=["FULL_TIME"],
            sort_by="priority",
            limit=limit,
        )

        exported = []
        from .processing.eligibility import EligibilityEngine
        engine = EligibilityEngine()

        for job in job_list:
            # Check previously submitted / archived jobs
            if job.status in [JobStatus.APPLIED, JobStatus.REJECTED, JobStatus.IGNORED, JobStatus.CLOSED]:
                continue

            # Dynamically verify eligibility against latest candidate parameters
            elig, reasons, stated_date, has_conflict = engine.evaluate(
                title=job.title,
                description=job.description or "",
                location=job.location,
                employment_type=job.employment_type,
                salary_min=job.salary_min,
            )
            if has_conflict or elig.value not in APPLICABLE:
                continue

            slug = re.sub(r"[^a-zA-Z0-9_-]", "-", f"{job.company_name.lower()}-{job.id}")
            salary_data = None
            if job.salary_min and job.salary_min > 0:
                salary_data = {
                    "min": float(job.salary_min),
                    "max": float(job.salary_max) if job.salary_max else float(job.salary_min),
                    "currency": "USD",
                    "period": "year",
                }

            exported.append({
                "id": slug,
                "company": job.company_name,
                "title": job.title,
                "location": job.location or "United States",
                "url": job.application_url or job.canonical_url,
                "country": "US",
                "sourceUrl": job.canonical_url,
                "scrapedAt": (job.last_seen or job.discovery_date or utc_now()).isoformat(),
                "startDate": None,
                "startDateEvidence": job.stated_start_date or "Not specified in posting",
                "fitAssessment": f"{job.best_career_cluster or 'Engineering'}: Priority score {job.priority_score:.1f}",
                "jobagentId": job.id,
                "salary": salary_data,
            })

        output.parent.mkdir(parents=True, exist_ok=True)
        with open(output, "w", encoding="utf-8") as f:
            json.dump(exported, f, indent=2)

        console.print(f"[bold green]✓[/bold green] Exported [cyan]{len(exported)}[/cyan] jobs to [white]{output}[/white]")


if __name__ == "__main__":
    app()


def _agent_dir():
    from jobagent.config import AGENT_DIR
    return AGENT_DIR

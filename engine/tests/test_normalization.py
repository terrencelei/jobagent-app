"""Tests for text, URL, title, location, and salary normalization."""

import pytest
from jobagent.processing.normalize import (
    canonicalize_url,
    compute_description_hash,
    detect_seniority,
    extract_salary,
    normalize_location,
    normalize_text,
    normalize_title,
)


def test_url_canonicalization_tracking_removal():
    url = "https://boards.greenhouse.io/andurilindustries/jobs/12345?gh_jid=12345&utm_source=linkedin&utm_medium=job_post&ref=referral/"
    clean = canonicalize_url(url)
    assert "utm_source" not in clean
    assert "utm_medium" not in clean
    assert "ref" not in clean
    assert clean == "https://boards.greenhouse.io/andurilindustries/jobs/12345"


def test_url_canonicalization_lever_and_ashby():
    lever_url = "https://jobs.lever.co/hermeus/abcd-1234-efgh?lever-source=Applied&mode=json"
    clean_lever = canonicalize_url(lever_url)
    assert clean_lever == "https://jobs.lever.co/hermeus/abcd-1234-efgh"

    ashby_url = "https://jobs.ashbyhq.com/varda/998877?ashby_jid=998877"
    clean_ashby = canonicalize_url(ashby_url)
    assert clean_ashby == "https://jobs.ashbyhq.com/varda/998877"


def test_title_normalization():
    assert normalize_title("Mechanical Design Engineer [Req-7894094003]") == "Mechanical Design Engineer"
    assert normalize_title("Product Design Engineer (JR2026518655)") == "Product Design Engineer"
    assert normalize_title("Robotics Engineer (7894094003)") == "Robotics Engineer"
    assert normalize_title("Hardware Engineer 🚀") == "Hardware Engineer"


def test_detect_seniority():
    sen, is_sen, is_ec = detect_seniority("Senior Mechanical Engineer")
    assert is_sen is True
    assert is_ec is False

    sen, is_sen, is_ec = detect_seniority("Staff Robotics Engineer")
    assert is_sen is True

    sen, is_sen, is_ec = detect_seniority("Mechanical Engineer, New Grad 2027")
    assert is_sen is False
    assert is_ec is True

    sen, is_sen, is_ec = detect_seniority("Associate Systems Engineer I")
    assert is_ec is True
    assert is_sen is False


def test_location_normalization():
    loc, is_remote, is_hybrid = normalize_location("Hawthorne, CA (Hybrid)")
    assert is_hybrid is True
    assert "Hawthorne" in loc

    loc, is_remote, is_hybrid = normalize_location("Remote - US")
    assert is_remote is True

    loc, is_remote, is_hybrid = normalize_location("San Francisco, California")
    assert "San Francisco" in loc


def test_salary_extraction():
    raw, min_val, max_val = extract_salary("The expected base salary range for this role is $95,000 - $125,000 per year.")
    assert min_val == 95000.0
    assert max_val == 125000.0

    raw, min_val, max_val = extract_salary("Compensation: $100k - $130k + equity")
    assert min_val == 100000.0
    assert max_val == 130000.0

    # Hourly to annualized
    raw, min_val, max_val = extract_salary("Hourly rate: $45.00 - $55.00 / hr")
    assert min_val == 45.0 * 2080
    assert max_val == 55.0 * 2080


def test_description_hash():
    desc1 = "<p>Design high-performance <b>actuators</b> and mechanisms.</p>"
    desc2 = "Design high-performance actuators and mechanisms."
    assert compute_description_hash(desc1) == compute_description_hash(desc2)

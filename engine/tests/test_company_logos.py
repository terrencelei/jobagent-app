import json

from jobagent.ui import company_logos


def test_plain_name_and_domain_choice():
    assert company_logos.plain('Amazon.jobs') == 'Amazon'
    assert company_logos.plain('Campbell Scientific, Inc.') == 'Campbell Scientific'
    suggestions = [{'name': 'Johnson & Johnson Innovation', 'domain': 'jnjinnovation.com'}, {'name': 'Johnson & Johnson', 'domain': 'jnj.com'}]
    assert company_logos.pick_domain('Johnson & Johnson', suggestions[::-1]) == 'jnj.com'
    assert company_logos.pick_domain('Apple', [{'name': 'Applebees', 'domain': 'applebees.com'}]) is None
    assert company_logos.pick_domain('Apple', [{'name': 'Apple', 'domain': 'javascript:alert(1)'}]) is None


def test_lookup_fetches_once_then_serves_from_disk(tmp_path, monkeypatch):
    monkeypatch.setattr(company_logos, '_directory', lambda: tmp_path)
    calls = []

    def fetch(url, timeout=6.0):
        calls.append(url)
        if 'suggest' in url:
            return json.dumps([{'name': 'Formlabs', 'domain': 'formlabs.com'}]).encode(), 'application/json'
        return b'\x89PNG' + b'0' * 400, 'image/png'

    first = company_logos.lookup('Formlabs', fetch=fetch)
    assert first and first[1] == 'image/png' and len(calls) == 2 and calls[1].endswith('formlabs.com')
    assert company_logos.lookup('Formlabs', fetch=fetch) == first and len(calls) == 2
    # No confident match is remembered, so the name is not searched again.
    assert company_logos.lookup('Zzqx Unknown', fetch=lambda url, timeout=6.0: (b'[]', 'application/json')) is None
    assert company_logos.lookup('Zzqx Unknown', fetch=fetch) is None and len(calls) == 2


def test_offline_lookup_is_not_remembered(tmp_path, monkeypatch):
    monkeypatch.setattr(company_logos, '_directory', lambda: tmp_path)

    def offline(url, timeout=6.0):
        raise OSError('no network')

    assert company_logos.lookup('Formlabs', fetch=offline) is None
    assert not (tmp_path / 'index.json').exists()


def test_posting_page_logo_is_preferred(tmp_path, monkeypatch):
    monkeypatch.setattr(company_logos, '_directory', lambda: tmp_path)
    page = b'<html><head><meta property="og:image" content="/share.png"></head><body><img class="company-logo" src="//cdn.example.com/acme.png"></body></html>'
    calls = []

    def fetch(url, timeout=6.0):
        calls.append(url)
        return (page, 'text/html') if url.endswith('/jobs/1') else (b'\x89PNG' + b'1' * 400, 'image/png')

    assert company_logos.logo_candidates(page.decode(), 'https://boards.example.com/acme/jobs/1') == ['https://cdn.example.com/acme.png', 'https://boards.example.com/share.png']
    found = company_logos.lookup('Acme Robotics', fetch=fetch, posting_url='https://boards.example.com/acme/jobs/1')
    assert found and calls == ['https://boards.example.com/acme/jobs/1', 'https://cdn.example.com/acme.png']
    assert company_logos.from_posting('http://localhost:8000/x', fetch) is None

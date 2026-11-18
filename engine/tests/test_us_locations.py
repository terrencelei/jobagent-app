import json
from unittest.mock import MagicMock
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from jobagent.processing.us_locations import is_us_location
from jobagent.db.models import Base, Job, JobStatus, EligibilityStatus
from jobagent.db.repository import JobRepository
from jobagent.tracking.lifecycle import JobLifecyclePipeline
from jobagent.scrapers.browser_sites import BrowserCareerScraper

@pytest.mark.parametrize('location',[
    'United States','USA','US','U.S.','Remote (United States)','Remote - US',
    'Austin, TX','Foster City, CA','New York, NY','New Mexico','Santa Clara, California',
    'Washington, DC','Ontario, CA','Dublin, California','Bay Area, California',
    ['Remote (Taiwan)','Sunnyvale, CA'],'Singapore; Sunnyvale, CA',
])
def test_confirmed_us_locations(location):
    assert is_us_location(location)

@pytest.mark.parametrize('location',[
    None,'','Remote','Worldwide','Anywhere','Unspecified Location','Hybrid','London, UK',
    'Remote (Singapore)','Remote (Taiwan)','Toronto, Canada','Dublin, Ireland',
    'Cambridge, United Kingdom','Paris, France','Sydney, Australia','Berlin, Germany',
    'Singapore; Remote (Taiwan)','Georgia','Tokyo, Japan','Remote - APAC',
    'Toronto, CA, Canada','California, Canada','Bangalore, India',
])
def test_foreign_and_unconfirmed_locations(location):
    assert not is_us_location(location)

@pytest.fixture
def session():
    engine=create_engine('sqlite:///:memory:');Base.metadata.create_all(engine)
    with sessionmaker(bind=engine)() as session:
        yield session


def job(location):
    return dict(company_name='Fixture',title='Mechanical Engineer',location=location,
        description='Mechanical design. BS Mechanical Engineering. Entry level.',
        canonical_url='https://example.com/jobs/fixture',application_url='https://example.com/jobs/fixture',source_ats='direct')


def test_repository_refuses_foreign_or_unknown_even_with_eligible_verdict(session):
    repo=JobRepository(session)
    for location in ['Remote (Taiwan); Remote (Singapore)','',None,'Remote']:
        with pytest.raises(ValueError,match='U.S.-only'):
            repo.upsert_job({**job(location),'eligibility':EligibilityStatus.ELIGIBLE})
    assert session.query(Job).count()==0
    saved,created,_=repo.upsert_job(job('Sunnyvale, CA'))
    assert created and saved.id
    with pytest.raises(ValueError,match='U.S.-only'):
        repo.upsert_job(job('Singapore'))
    assert saved.location=='Sunnyvale, CA'


def test_pipeline_blocks_before_ranking_even_if_pruning_disabled(session,monkeypatch):
    from jobagent import settings
    original=settings.setting
    monkeypatch.setattr(settings,'setting',lambda key,*a,**kw: False if key=='pruning.enabled' else original(key,*a,**kw))
    pipeline=JobLifecyclePipeline(session)
    pipeline.tracks=MagicMock()
    results=pipeline.process_discovered_jobs([job('Remote (Taiwan); Remote (Singapore)'),job('Remote'),job('')])
    assert results['skipped_non_us_or_unknown']==3
    assert results['errors_count']==0
    pipeline.tracks.evaluate.assert_not_called()
    assert session.query(Job).count()==0


def test_rippling_location_metadata_beats_us_headquarters_prose():
    scraper=BrowserCareerScraper()
    context=MagicMock();page=context.new_page.return_value
    page.inner_text.return_value=('Assembly and Packaging Process Engineer\n'+'Mechanical engineering role. '*15+
        '\nLyte is headquartered in Sunnyvale, California.\nRemote (Taiwan)\nRemote (Singapore)')
    page.locator.return_value.text_content.return_value=json.dumps({'props':{'pageProps':{'apiData':{'jobPost':{'workLocations':['Remote (Taiwan)','Remote (Singapore)']}}}}})
    try:
        raw=scraper._read_posting(context,'https://ats.rippling.com/lyte/jobs/fixture',
            'https://ats.rippling.com/lyte/jobs/fixture','Fixture','Mechanical Engineer')
        assert raw['location']=='Remote (Taiwan); Remote (Singapore)'
        assert not is_us_location(raw['location'])
    finally:
        scraper.close()


def test_queue_refuses_existing_international_job_even_with_positive_fit_label(session,tmp_path):
    from jobagent.services.application_runner import ApplicationRunner
    # Old records may predate the admission policy; saved fit labels do not override it.
    session.add(Job(id=1,company_name='Fixture',title='Mechanical Engineer',
        location='Singapore',description='Fixture',source_ats='direct',user_fit_label={'fit':True},canonical_url='https://example.com/jobs/1',application_url='https://example.com/jobs/1',
        status=JobStatus.NEW,eligibility=EligibilityStatus.ELIGIBLE,role_type='FULL_TIME'))
    session.commit()
    class Sessions:
        def __call__(self):
            class Context:
                def __enter__(self):return session
                def __exit__(self,*args):pass
            return Context()
    runner=ApplicationRunner(tmp_path/'runs',tmp_path/'agent',Sessions())
    with pytest.raises(ValueError,match='U.S.-only'):
        runner.queue([1])
    assert not runner.data['jobs']


def test_bare_unambiguous_us_cities_count_as_us():
    for location in ['Los Angeles', 'El Segundo', 'Seattle', 'Santa Clara', 'Austin', 'Los Angeles; Remote']:
        assert is_us_location(location), location
    for location in ['London', 'Paris', 'Cambridge', 'Dublin', 'Vancouver', 'Remote', 'Los Angeles, Mexico']:
        assert not is_us_location(location), location

# River Data Monitor

Water height at Causey Bridge on Sankey Brook in Warrington, with a record of what each import accepted or rejected.

[Open the dashboard](https://river.artemislab.co.uk/)

The gauge records a reading every 15 minutes. The chart breaks its line whenever consecutive published observation times are more than 15 minutes apart, measured in UTC. Open Reading gaps to see the observations on either side and the elapsed time. The slider and step buttons select an actual reading within the chosen range and show its time and height. The CSV contains those same readings with the original precision and times in UTC. The dashboard displays times in the UK time zone.

Python reads the latest 72 hours from the Environment Agency API. DuckDB merges on the UTC reading time, so replayed readings leave one row per timestamp and provider corrections replace the stored height. An invalid row is counted by reason. If the whole batch fails, the log records the failure and the previous readings are kept.

GitHub Actions is scheduled to check the feed every two hours and publish the JSON report to the data branch. The dashboard shows when a check actually ran and when the latest reading was measured. The provider can deliver readings in batches. Cloudflare serves a dated backup if the latest report cannot load.

## Run locally

    python -m pip install -r requirements.txt
    python monitor.py
    python -m http.server 4178 -d web

Open http://localhost:4178. Running the import again updates the same snapshot.

    python -m unittest discover -s tests -v
    node --test tests/worker.test.mjs

This uses Environment Agency flood and river level data from the real-time data API (Beta) under the [Open Government Licence](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). For official flood information use [GOV.UK](https://check-for-flooding.service.gov.uk/).

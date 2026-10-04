# 尾班車 Last Train — night watcher 夜間觀察者

Every night one long job watches the entire MTR network through the
[Next Train API](https://data.gov.hk) — polling all 121 line-stations every 3 minutes
from 22:30 to 02:10 HKT and recording the final train each station showed before
going dark.

The result, `data/last-trains.json`, is a living public record of Hong Kong's real
last trains — learned by observation, not copied from a timetable. It refreshes
itself nightly and automatically captures special timetables (festivals, typhoons,
extended service).

**App:** https://last-train-smoky.vercel.app · a full-screen countdown to your last train home.

- `collect.mjs` — the watcher (no dependencies, Node 20)
- `.github/workflows/watch.yml` — the nightly schedule (several start times; only one has to fire)
- `data/observations.json` — tonight's raw sightings + the times the watcher looked (`polls`)
- `data/last-trains.json` — the learned dataset (median of up to 14 nights per station/direction).
  A night only counts for a station if the watcher looked at least 10 min before its last
  train and never looked away for more than 12 min until the network was dark (01:45).
  The app stops trusting a station after 7 days without a fresh night.

### If nights still go missing

GitHub's scheduler is best-effort: from 27 Aug to 3 Oct 2026 it dropped almost every
run, so the old one-job-per-10-minutes design saw nothing for 38 nights. If the
`🌙 observations` commits stop again, start the night from outside with a free
scheduler (e.g. cron-job.org), daily at 22:40 HKT:

```
POST https://api.github.com/repos/ecthink/last-train/actions/workflows/watch.yml/dispatches
Authorization: Bearer <fine-grained token: this repo only, Actions = read & write>
Accept: application/vnd.github+json
{"ref": "main"}
```

Part of a series of small things built on everyday Hong Kong systems.
Inspired by Riley Walz. Built with Claude (vibe coding).

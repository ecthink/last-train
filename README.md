# 尾班車 Last Train — night watcher 夜間觀察者

Every night between 23:00 and 02:30 HKT, this repo watches the entire MTR network
through the [Next Train API](https://data.gov.hk) — polling all ~100 stations every
10 minutes and recording the final train each station ever showed before going dark.

The result, `data/last-trains.json`, is a living public record of Hong Kong's real
last trains — learned by observation, not copied from a timetable. It refreshes
itself nightly and automatically captures special timetables (festivals, typhoons,
extended service).

**App:** https://last-train.vercel.app · a full-screen countdown to your last train home.

- `collect.mjs` — the watcher (no dependencies, Node 20)
- `.github/workflows/watch.yml` — the nightly schedule
- `data/observations.json` — tonight's raw sightings
- `data/last-trains.json` — the learned dataset (median of up to 14 nights per station/direction)

Part of a series of small things built on everyday Hong Kong systems.
Inspired by Riley Walz. Built by Tina × Claude (vibe coding).

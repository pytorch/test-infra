"""Landed changes over the configs that failed at their main push: each change's scores
cut over that config's own test list, as TD cuts each job (the shadow recall on HUD's
Target Determinator page reads the same lists), for the reverted breakages (gold) and the
new failures on main (silver)."""

from statistics import median
from typing import Any

import pandas as pd
from torchci.td.analysis import config
from torchci.td.analysis.labels import unix
from torchci.td.analysis.selection import Unit


ELIGIBLE = ("false_green", "signal_on_pr", "passed_on_pr")


class Views:
    """Per push, the failing configs' test lists and failing files; and the config views
    of the changes evaluated on them, built once."""

    def __init__(
        self,
        ranks: pd.DataFrame,
        units: dict[str, Unit],
        budgets: dict[str, dict[int, int]],
        scales: dict[str, float],
    ) -> None:
        self.lists: dict[str, dict[tuple[str, str], tuple[list[str], set[str]]]] = {}
        for (push, env, cfg), g in ranks.groupby(
            ["push_sha", "build_environment", "test_config"]
        ):
            self.lists.setdefault(push, {})[(env, cfg)] = (
                list(g["candidates"].iloc[0]),
                set(g["file"]),
            )
        self.units, self.budgets, self.scales = units, budgets, scales
        self.built: dict[str, Unit] = {}

    def view(self, uid: str, push: str, env: str, cfg: str) -> Unit:
        key = f"{uid}|{env}|{cfg}"
        if key not in self.built:
            u, cands = self.units[uid], self.lists[push][(env, cfg)][0]
            fill = median(u.seconds.values())
            v = Unit(
                key,
                cands,
                u.before,
                u.after,
                {t: u.seconds.get(t, fill) for t in cands},
            )
            v.add_adaptive(self.budgets[uid], self.scales[uid])
            self.built[key] = v
        return self.built[key]

    def events(
        self, inputs: list[tuple[list[str], str, set[str]]]
    ) -> tuple[list, list[int]]:
        """(commit units, landing push, failing files) -> recall events over config views,
        and the indices of the inputs that had config lists."""
        events, kept = [], []
        for i, (uids, push, files) in enumerate(inputs):
            fmap = {}
            for (env, cfg), (_, failed) in self.lists.get(push, {}).items():
                hit = files & failed
                for uid in uids:
                    if hit and uid in self.units:
                        v = self.view(uid, push, env, cfg)
                        fmap[v.uid] = sorted(hit & set(v.tests))
            if any(fmap.values()):
                events.append((sorted(fmap), fmap))
                kept.append(i)
        return events, kept


def gold_events(
    views: Views, ev: pd.DataFrame, gold: pd.DataFrame
) -> tuple[list, list[str], int, int]:
    """Recall events of the eligible reverted breakages in the evaluation weeks, their
    outcomes, how many had no config lists, and how many false greens the window holds."""
    commit_unit = {
        ev.loc[u, "sha"]: u for u in views.units if ev.loc[u, "kind"] == "main"
    }
    g = gold[gold["outcome"].isin(ELIGIBLE) & gold["window_closed"]]
    g = g[g["landed_at"].map(unix) >= unix(str(config.EVAL_START))]
    inputs = [
        (
            [commit_unit[s] for s in e.commit_shas if s in commit_unit],
            e.landing_sha,
            set(e.test_files),
        )
        for e in g.itertuples()
    ]
    events, kept = views.events(inputs)
    return (
        events,
        [g["outcome"].iloc[i] for i in kept],
        len(g) - len(kept),
        int((g["outcome"] == "false_green").sum()),
    )


def silver_events(
    views: Views, ev: pd.DataFrame, silver_pos: dict[str, list[str]]
) -> tuple[list, dict[str, Any]]:
    """Recall events of the new failures on main, and each change's event by unit id."""
    ids = list(silver_pos)
    events, kept = views.events(
        [([u], ev.loc[u, "sha"], set(silver_pos[u])) for u in ids]
    )
    return events, {ids[i]: e for i, e in zip(kept, events)}

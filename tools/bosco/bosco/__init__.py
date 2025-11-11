from __future__ import annotations

import curses

from bosco import github, model, ui


class Bosco:
    def __init__(self, /, *, gh: github.GH) -> None:
        self.gh = gh

    async def init(self, /, prs: list[int]) -> None:
        for pr_id in prs:
            pr = await model.PR.query(
                self.gh, github.PR(github.Repository('pytorch', 'pytorch'), id=pr_id)
            )
            NOT_USER_FACING_LABEL = 'topic: not user facing'
            CIFLOW_TRUNK_LABEL = 'ciflow/trunk'
            REVIEWERS = ['ezyang', 'skylion007']
            current_labels: set[str] = set(pr.labels)
            LABELS_TO_KEEP = {
                CIFLOW_TRUNK_LABEL,
                NOT_USER_FACING_LABEL,
            }
            labels_to_remove = current_labels - LABELS_TO_KEEP
            await self.gh.pr.edit(
                pr,
                reviewers=REVIEWERS,
                add_labels=[NOT_USER_FACING_LABEL],
                remove_labels=labels_to_remove,
            )

    async def watch(self, /, stdscr: curses.window, pr_ids: list[int]) -> None:
        app = ui.UI(stdscr, pr_ids)
        await app.run()

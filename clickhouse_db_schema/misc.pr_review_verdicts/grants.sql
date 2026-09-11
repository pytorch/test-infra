-- Grant SELECT to hud_user so HUD / Dr.CI can render the review verdict.
-- Rendering is the whole point of the table: the workflow posts nothing to the
-- pull request, so this row is the only path from a review to a human.
--
-- Most tables in this directory carry no grants.sql, which suggests a default
-- role already covers hud_user. This file is explicit rather than assumed;
-- @clee2000 / @huydhn should drop it if the default role makes it redundant.
GRANT SELECT ON misc.pr_review_verdicts TO hud_user;

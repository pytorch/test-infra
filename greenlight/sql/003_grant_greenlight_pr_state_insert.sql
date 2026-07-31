-- Grant INSERT to hud_user (the greenlight PR-review workflow records verdicts here).
-- Not auto-applied from this repo: ClickHouse grants are provisioned manually — ask clee2000 or huydhn to run this.
GRANT INSERT ON misc.greenlight_pr_state TO hud_user;

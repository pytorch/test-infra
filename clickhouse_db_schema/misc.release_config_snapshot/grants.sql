-- HUD reads the release index and the config endpoint from here.
GRANT SELECT ON misc.release_config_snapshot TO hud_user;
-- The collector workflow appends. Replace `release_portal_writer` with the user the
-- collector will use (to be decided with the ClickHouse admins before this is applied).
-- GRANT INSERT ON misc.release_config_snapshot TO release_portal_writer;

-- HUD reads the release board and the release index from here.
GRANT SELECT ON misc.release_event TO hud_user;
-- The collector workflow appends. Replace `release_portal_writer` with the user the
-- collector will use (to be decided with the ClickHouse admins before this is applied).
-- GRANT INSERT ON misc.release_event TO release_portal_writer;

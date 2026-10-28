-- Definer of misc.clickhouse_insert_health_mv. HOST NONE blocks logins, so the password is
-- never used: generate a random one (e.g. openssl rand -base64 32) and discard it.
CREATE USER insert_health_definer IDENTIFIED BY '<generated>' HOST NONE;
-- only the columns the view reads; no query or exception text
GRANT SELECT(
    event_date, event_time, type, query_kind, is_initial_query, exception_code, tables,
    ProfileEvents
) ON system.query_log TO insert_health_definer;
-- clusterAllReplicas needs SHOW COLUMNS on the whole table, and READ ON REMOTE
GRANT SHOW COLUMNS ON system.query_log TO insert_health_definer;
GRANT READ ON REMOTE TO insert_health_definer;
GRANT INSERT ON misc.clickhouse_insert_health TO insert_health_definer;

-- Grafana reads via the read_only role (SELECT ON misc.*); no grant needed.

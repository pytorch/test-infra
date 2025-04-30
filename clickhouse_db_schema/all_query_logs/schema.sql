CREATE TABLE all_query_logs
ENGINE = Merge('system', '^query_log(_\\d+)?$');
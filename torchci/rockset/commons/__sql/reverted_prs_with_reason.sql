SELECT 
    ic._event_time revert_time,
	ic.user.login as reverter,
    REGEXP_EXTRACT(ic.body, '-c[\s =]+"?(\w+)"?', 1) as code,
    REGEXP_EXTRACT(ic.body, '-m[\s =]+["'']?([^"'']+)["'']?', 1) as message,
    ic.html_url as comment_url
FROM commons.issue_comment AS ic
	INNER JOIN 
    (
      SELECT 
        issue_comment.issue_url,
        MAX(issue_comment._event_time) as event_time -- Use the max for when invalid revert commands are tried first
      FROM commons.issue_comment
      WHERE issue_comment.body LIKE '@pytorchbot revert%'
          OR issue_comment.body LIKE '@pytorchmergebot revert%'
          OR issue_comment.body LIKE '@mergebotbot revert%'
      GROUP BY issue_comment.issue_url
    ) AS rc ON ic.issue_url = rc.issue_url
WHERE
	ic._event_time = rc.event_time 
    AND ic._event_time >= PARSE_DATETIME_ISO8601(:startTime)
    AND ic._event_time < PARSE_DATETIME_ISO8601(:stopTime)
ORDER BY code DESC
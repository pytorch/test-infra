SELECT
    duration_sec,
    name,
FROM (
    SELECT
    	tts.*,
    	PERCENT_RANK() OVER (ORDER BY duration_sec DESC) AS percentile
    FROM (
    	SELECT
        	DATE_DIFF(
        		'second',
            	PARSE_TIMESTAMP_ISO8601(workflow.created_at),
            	PARSE_TIMESTAMP_ISO8601(workflow.updated_at)
        	) as duration_sec,
      		name,
    	FROM
        	commons.workflow_run workflow
    	WHERE
    		conclusion = 'success'
        	AND workflow.name = :name
        	AND workflow._event_time >= PARSE_DATETIME_ISO8601(:startTime)
        	AND workflow._event_time < PARSE_DATETIME_ISO8601(:stopTime)
    ) AS tts
) AS p
WHERE
	percentile >= (1.0 - :percentile)
ORDER BY
	duration_sec DESC
LIMIT
	1

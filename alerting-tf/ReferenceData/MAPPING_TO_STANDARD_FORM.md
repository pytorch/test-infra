Pair this file with REFERENCE_DATA.md

The AWS CloudWatch Alarm doesn't give us much room to add custom annotations to the alert, so we stick everything we want into the body of the alarm description.

Here's an example of the body format expected so that settings can be extracted.:

```json
  "AlarmDescription": "Our Alert Description.\n\nCould be multi-line\nTEAM=some-team\nPRIORITY=P1\nRUNBOOK=<runbook_url>\nDashboard=<dashboard_url>\n",
```


The above should be parsed as. Note that the keys for the fields that are defined as KEY=VALUE should NOT be considered case sensitive.
```
Description:
  Our Alert Description.
  Could be multi-line
Team: some-team
Priority: P1
Runbook: <runbook_url>
Dashboard: <dashboard_url>
```

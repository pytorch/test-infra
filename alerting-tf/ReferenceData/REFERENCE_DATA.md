# Data Shapes
This file contains generic data shapes so that we can understand how data looks as it passes through the system.

# AWS Cloudwatch Alerts
## Envelop created around SNS -> Queue messages
If a message is passed to SNS that looks like this:
```json
{"hello":"dev for github"}
```

What will be received by the collector lambda is this:
```json
{
  messageId: '5c939a8e-9c8d-4fe3-86fa-8f473e8ad057',
  receiptHandle: 'AQEB0...long_string...6fw==',
  body: '{"hello":"dev for github"}',
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '1758041806210',
    SenderId: 'AIDAIT2UOQQY3AUEKVGXU',
    ApproximateFirstReceiveTimestamp: '1758041806222'
  },
  messageAttributes: {},
  md5OfMessageAttributes: null,
  md5OfBody: '9c96f34d85827fbb7a02446744b41858',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:308535385114:alerting-dev-alerts',
  awsRegion: 'us-east-1'
}
```

## Message (with envelop) received when an AWS Alarm fires, with basic body setup:

```json
{
  messageId: 'd2af6eed-107f-4916-b4d8-4ff649a1afe3',
  receiptHandle: 'AQE...RQw==',
  body: '{"AlarmName":"[TITLE-TEST-ALARM] Title of Broken Alarm","AlarmDescription":"Body of alarm.\\nStats:\\nTEAM=foobar\\nPriority=P1","AWSAccountId":"308535385114","AlarmConfigurationUpdatedTimestamp":"2025-09-16T16:54:41.676+0000","NewStateValue":"ALARM","NewStateReason":"Threshold Crossed: 1 out of the last 1 datapoints [596.3636363636364 (16/09/25 16:58:00)] was greater than the threshold (580.0) (minimum 1 datapoint for OK -> ALARM transition).","StateChangeTime":"2025-09-16T16:59:17.131+0000","Region":"US East (N. Virginia)","AlarmArn":"arn:aws:cloudwatch:us-east-1:308535385114:alarm:[TITLE-TEST-ALARM] Title of Broken Alarm","OldStateValue":"OK","OKActions":[],"AlarmActions":["arn:aws:sns:us-east-1:308535385114:alerting-dev-alerts"],"InsufficientDataActions":[],"Trigger":{"MetricName":"run.ghrunners.perOrg.perRunnerType.busy","Namespace":"gh-ci-scaleUp-dim","StatisticType":"Statistic","Statistic":"AVERAGE","Unit":null,"Dimensions":[{"value":"pytorch","name":"Org"},{"value":"linux.2xlarge","name":"RunnerType"}],"Period":60,"EvaluationPeriods":1,"DatapointsToAlarm":1,"ComparisonOperator":"GreaterThanThreshold","Threshold":580.0,"TreatMissingData":"notBreaching","EvaluateLowSampleCountPercentile":""}}',
  attributes: {
    ApproximateReceiveCount: '1',
    SentTimestamp: '1758041957206',
    SenderId: 'AIDAIT2UOQQY3AUEKVGXU',
    ApproximateFirstReceiveTimestamp: '1758041957230'
  },
  messageAttributes: {},
  md5OfMessageAttributes: null,
  md5OfBody: '7702f0e0353d0928de622d63459a8c4e',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:308535385114:alerting-dev-alerts',
  awsRegion: 'us-east-1'
}
```

Extracting just the body of the message, it looks like:

```json
{
  "AlarmName": "[TITLE-TEST-ALARM] Title of Broken Alarm",
  "AlarmDescription": "Body of alarm.\\nStats:\\nTEAM=foobar\\nPriority=P1", // <-- Note the \\n is how it was printed to console. I don't know if the message itself was actually doubly slashed
  "AWSAccountId": "308535385114",
  "AlarmConfigurationUpdatedTimestamp": "2025-09-16T16:54:41.676+0000",
  "NewStateValue": "ALARM",
  "NewStateReason": "Threshold Crossed: 1 out of the last 1 datapoints [596.3636363636364 (16/09/25 16:58:00)] was greater than the threshold (580.0) (minimum 1 datapoint for OK -> ALARM transition).",
  "StateChangeTime": "2025-09-16T16:59:17.131+0000",
  "Region": "US East (N. Virginia)",
  "AlarmArn": "arn:aws:cloudwatch:us-east-1:308535385114:alarm:[TITLE-TEST-ALARM] Title of Broken Alarm",
  "OldStateValue": "OK",
  "OKActions": [],
  "AlarmActions": [
    "arn:aws:sns:us-east-1:308535385114:alerting-dev-alerts"
  ],
  "InsufficientDataActions": [],
  "Trigger": {
    "MetricName": "run.ghrunners.perOrg.perRunnerType.busy",
    "Namespace": "gh-ci-scaleUp-dim",
    "StatisticType": "Statistic",
    "Statistic": "AVERAGE",
    "Unit": null,
    "Dimensions": [
      {
        "value": "pytorch",
        "name": "Org"
      },
      {
        "value": "linux.2xlarge",
        "name": "RunnerType"
      }
    ],
    "Period": 60,
    "EvaluationPeriods": 1,
    "DatapointsToAlarm": 1,
    "ComparisonOperator": "GreaterThanThreshold",
    "Threshold": 580.0,
    "TreatMissingData": "notBreaching",
    "EvaluateLowSampleCountPercentile": ""
  }
}
```

# Grafana Alerts
## Test message (with envlope) sent by Grafana alert
The message Grafana used to validate that the notification can be emitted
```json
{
  messageId: 'e3e99ee4-b104-4da0-8e70-611d7506c9f4',
  receiptHandle: 'AQEB...A==',
  body: `{"receiver":"test","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"TestAlert","instance":"Grafana"},"annotations":{"summary":"Notification test"},"startsAt":"2025-09-16T17:11:19.283071388Z","endsAt":"0001-01-01T00:00:00Z","generatorURL":"","fingerprint":"57c6d9296de2ad39","silenceURL":"https://alertmanager-prod-us-west-0.grafana.net/alertmanager/alerting/silence/new?alertmanager=grafana\\u0026matcher=alertname%3DTestAlert\\u0026matcher=instance%3DGrafana","dashboardURL":"","panelURL":"","values":null,"valueString":"[ metric='foo' labels={instance=bar} value=10 ]"}],"groupLabels":{"alertname":"TestAlert","instance":"Grafana"},"commonLabels":{"alertname":"TestAlert","instance":"Grafana"},"commonAnnotations":{"summary":"Notification test"},"externalURL":"https://alertmanager-prod-us-west-0.grafana.net/alertmanager","version":"1","groupKey":"test-57c6d9296de2ad39-1758042679","truncatedAlerts":0,"orgId":1,"title":"[FIRING:1] TestAlert Grafana ","state":"alerting","message":"**Firing**\\n\\nValue: [no value]\\nLabels:\\n - alertname = TestAlert\\n - instance = Grafana\\nAnnotations:\\n - summary = Notification test\\nSilence: https://alertmanager-prod-us-west-0.grafana.net/alertmanager/alerting/silence/new?alertmanager=grafana\\u0026matcher=alertname%3DTestAlert\\u0026matcher=instance%3DGrafana\\n"}`,
  attributes: {
    ApproximateReceiveCount: '1',
    AWSTraceHeader: 'Root=1-68c99a37-6b1ff3af07da0ed107bc6f40;Parent=2d29ef145f52370c;Sampled=0;Lineage=1:0f0fba18:0',
    SentTimestamp: '1758042679634',
    SenderId: 'AIDAIT2UOQQY3AUEKVGXU',
    ApproximateFirstReceiveTimestamp: '1758042679638'
  },
  messageAttributes: {
    source: {
      stringValue: 'grafana',
      binaryValue: null,
      stringListValues: [],
      binaryListValues: [],
      dataType: 'String'
    }
  },
  md5OfMessageAttributes: '6c40e046d8d6cbe4b3b008430a8089d7',
  md5OfBody: '10109a2cc1f8ca395a43130e3d7ba950',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:308535385114:alerting-dev-alerts',
  awsRegion: 'us-east-1'
}
```

And just the body:

```json
{
  "receiver": "test",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "TestAlert",
        "instance": "Grafana"
      },
      "annotations": {
        "summary": "Notification test"
      },
      "startsAt": "2025-09-16T17:11:19.283071388Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "",
      "fingerprint": "57c6d9296de2ad39",
      "silenceURL": "https://alertmanager-prod-us-west-0.grafana.net/alertmanager/alerting/silence/new?alertmanager=grafana\\u0026matcher=alertname%3DTestAlert\\u0026matcher=instance%3DGrafana",
      "dashboardURL": "",
      "panelURL": "",
      "values": null,
      "valueString": "[ metric='foo' labels={instance=bar} value=10 ]"
    }
  ],
  "groupLabels": {
    "alertname": "TestAlert",
    "instance": "Grafana"
  },
  "commonLabels": {
    "alertname": "TestAlert",
    "instance": "Grafana"
  },
  "commonAnnotations": {
    "summary": "Notification test"
  },
  "externalURL": "https://alertmanager-prod-us-west-0.grafana.net/alertmanager",
  "version": "1",
  "groupKey": "test-57c6d9296de2ad39-1758042679",
  "truncatedAlerts": 0,
  "orgId": 1,
  "title": "[FIRING:1] TestAlert Grafana ",
  "state": "alerting",
  "message": "**Firing**\\n\\nValue: [no value]\\nLabels:\\n - alertname = TestAlert\\n - instance = Grafana\\nAnnotations:\\n - summary = Notification test\\nSilence: https://alertmanager-prod-us-west-0.grafana.net/alertmanager/alerting/silence/new?alertmanager=grafana\\u0026matcher=alertname%3DTestAlert\\u0026matcher=instance%3DGrafana\\n"
}
```

## Actual message sent by Grafana Alert (with envelop)

```json
{
  messageId: '6752c1ef-2bda-4f28-acf4-2678110aac19',
  receiptHandle: 'AQEBzos27ozJBh9+syaiVtjWkB+bv4GuDemeUAlMdz/08Dck5Mks1HzYUpvjVwKHkyLf41XmOIc9gJSL+Pfaumv1hV8HgUbFufkUzHHqyolQKtpIHXMB/6uFp34wlKm7phJ02c3FGFOGNRAjxFb+n6E32abPkaE3pdLDm0U2D0UiHbF6JmEBk6n/HtS0NlBW+YQVSIPJZxWY2dEH5K+mqh754zxCKxTEfbg6cehB4GG7J4hEneUfyEPgVdfzmXSREKVHdIUgR2P2YBY21LYGffJOpl7HbDZ65OANwRPmdlZHr9wuwB81ptfcO42lyOSuTOgWbMFbopmeQAUbkcF1LjZ7EPYriS7ijpoxBL3/i/9O12hbY7bdjC1FxdBZM1osjbn37WRHlSV/RoYqpvF5SCaw8w==',
  body: '{"receiver":"TEST AWS dev webhook alerting system","status":"firing","alerts":[{"status":"firing","labels":{"alertname":"DatasourceNoData","datasource_uid":"grafanacloud-prom","grafana_folder":"GrafanaCloud","ref_id":"A","rulename":"viable/strict is broken"},"annotations":{"Priority":"1","Team":"Team is us","description":"TEST MODE: You should have a description Fix HUD","runbook_url":"https://hud.pytorch.org","summary":"TEST MODE: this is summary: Viable/strict is broken"},"startsAt":"2025-09-16T17:12:20Z","endsAt":"0001-01-01T00:00:00Z","generatorURL":"https://pytorchci.grafana.net/alerting/grafana/eewi8oa4ccef4e/view?orgId=1","fingerprint":"c50ae7bba42b3626","silenceURL":"https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\\u0026matcher=__alert_rule_uid__%3Deewi8oa4ccef4e\\u0026matcher=datasource_uid%3Dgrafanacloud-prom\\u0026matcher=ref_id%3DA\\u0026matcher=rulename%3Dviable%2Fstrict+is+broken\\u0026orgId=1","dashboardURL":"https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\\u0026orgId=1\\u0026to=1758042776758","panelURL":"https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\\u0026orgId=1\\u0026to=1758042776758\\u0026viewPanel=1","values":null,"valueString":"","orgId":1}],"groupLabels":{"alertname":"DatasourceNoData","grafana_folder":"GrafanaCloud"},"commonLabels":{"alertname":"DatasourceNoData","datasource_uid":"grafanacloud-prom","grafana_folder":"GrafanaCloud","ref_id":"A","rulename":"viable/strict is broken"},"commonAnnotations":{"Priority":"1","Team":"Team is us","description":"TEST MODE: You should have a description Fix HUD","runbook_url":"https://hud.pytorch.org","summary":"TEST MODE: this is summary: Viable/strict is broken"},"externalURL":"https://pytorchci.grafana.net/","version":"1","groupKey":"{}/{__grafana_autogenerated__=\\"true\\"}/{__grafana_receiver__=\\"TEST AWS dev webhook alerting system\\"}:{alertname=\\"DatasourceNoData\\", grafana_folder=\\"GrafanaCloud\\"}","truncatedAlerts":0,"orgId":1,"title":"[FIRING:1] DatasourceNoData GrafanaCloud (grafanacloud-prom A viable/strict is broken)","state":"alerting","message":"**Firing**\\n\\nValue: [no value]\\nLabels:\\n - alertname = DatasourceNoData\\n - datasource_uid = grafanacloud-prom\\n - grafana_folder = GrafanaCloud\\n - ref_id = A\\n - rulename = viable/strict is broken\\nAnnotations:\\n - Priority = 1\\n - Team = Team is us\\n - description = TEST MODE: You should have a description Fix HUD\\n - runbook_url = https://hud.pytorch.org\\n - summary = TEST MODE: this is summary: Viable/strict is broken\\nSource: https://pytorchci.grafana.net/alerting/grafana/eewi8oa4ccef4e/view?orgId=1\\nSilence: https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\\u0026matcher=__alert_rule_uid__%3Deewi8oa4ccef4e\\u0026matcher=datasource_uid%3Dgrafanacloud-prom\\u0026matcher=ref_id%3DA\\u0026matcher=rulename%3Dviable%2Fstrict+is+broken\\u0026orgId=1\\nDashboard: https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\\u0026orgId=1\\u0026to=1758042776758\\nPanel: https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\\u0026orgId=1\\u0026to=1758042776758\\u0026viewPanel=1\\n"}',
  attributes: {
    ApproximateReceiveCount: '1',
    AWSTraceHeader: 'Root=1-68c99a98-2e8b34a4190435cc21f93d72;Parent=25b61140447da06d;Sampled=0;Lineage=1:0f0fba18:0',
    SentTimestamp: '1758042777088',
    SenderId: 'AIDAIT2UOQQY3AUEKVGXU',
    ApproximateFirstReceiveTimestamp: '1758042777089'
  },
  messageAttributes: {
    source: {
      stringValue: 'grafana',
      binaryValue: null,
      stringListValues: [],
      binaryListValues: [],
      dataType: 'String'
    }
  },
  md5OfMessageAttributes: '6c40e046d8d6cbe4b3b008430a8089d7',
  md5OfBody: 'e8fe039bd1cb7bc98cae15ce0209605b',
  eventSource: 'aws:sqs',
  eventSourceARN: 'arn:aws:sqs:us-east-1:308535385114:alerting-dev-alerts',
  awsRegion: 'us-east-1'
}
```

And the message body only once I took it out of the envelop (I've replaced double backward slashes with single slashes, suspecting that those were added by the console)

```json
{
  "receiver":"TEST AWS dev webhook alerting system",
  "status":"firing",
  "alerts":[
    {
      "status":"firing",
      "labels":
        {
          "alertname":"DatasourceNoData",
          "datasource_uid":"grafanacloud-prom",
          "grafana_folder":"GrafanaCloud",
          "ref_id":"A",
          "rulename":"viable/strict is broken"
        },
      "annotations":
        {
          "Priority":"1",
          "Team":"Team is us",
          "description":"TEST MODE: You should have a description Fix HUD",
          "runbook_url":"https://hud.pytorch.org",
          "summary":"TEST MODE: this is summary: Viable/strict is broken"
        },
      "startsAt":"2025-09-16T17:12:20Z",
      "endsAt":"0001-01-01T00:00:00Z",
      "generatorURL":"https://pytorchci.grafana.net/alerting/grafana/eewi8oa4ccef4e/view?orgId=1",
      "fingerprint":"c50ae7bba42b3626",
      "silenceURL":"https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\u0026matcher=__alert_rule_uid__%3Deewi8oa4ccef4e\u0026matcher=datasource_uid%3Dgrafanacloud-prom\u0026matcher=ref_id%3DA\u0026matcher=rulename%3Dviable%2Fstrict+is+broken\u0026orgId=1",
      "dashboardURL":"https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\u0026orgId=1\u0026to=1758042776758",
      "panelURL":"https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\u0026orgId=1\u0026to=1758042776758\u0026viewPanel=1",
      "values":null,
      "valueString":"",
      "orgId":1
    }
  ],
  "groupLabels": {
    "alertname": "DatasourceNoData",
    "grafana_folder": "GrafanaCloud"
  },
  "commonLabels": {
    "alertname": "DatasourceNoData",
    "datasource_uid": "grafanacloud-prom",
    "grafana_folder": "GrafanaCloud",
    "ref_id": "A",
    "rulename": "viable/strict is broken"
  },
  "commonAnnotations": {
    "Priority": "1",
    "Team": "Team is us",
    "description": "TEST MODE: You should have a description Fix HUD",
    "runbook_url": "https://hud.pytorch.org",
    "summary": "TEST MODE: this is summary: Viable/strict is broken"
  },
  "externalURL": "https://pytorchci.grafana.net/",
  "version": "1",
  "groupKey": "{}/{__grafana_autogenerated__=\"true\"}/{__grafana_receiver__=\"TEST AWS dev webhook alerting system\"}:{alertname=\"DatasourceNoData\", grafana_folder=\"GrafanaCloud\"}",
  "truncatedAlerts": 0,
  "orgId": 1,
  "title": "[FIRING:1] DatasourceNoData GrafanaCloud (grafanacloud-prom A viable/strict is broken)",
  "state": "alerting",
  "message": "**Firing**\n\nValue: [no value]\nLabels:\n - alertname = DatasourceNoData\n - datasource_uid = grafanacloud-prom\n - grafana_folder = GrafanaCloud\n - ref_id = A\n - rulename = viable/strict is broken\nAnnotations:\n - Priority = 1\n - Team = Team is us\n - description = TEST MODE: You should have a description Fix HUD\n - runbook_url = https://hud.pytorch.org\n - summary = TEST MODE: this is summary: Viable/strict is broken\nSource: https://pytorchci.grafana.net/alerting/grafana/eewi8oa4ccef4e/view?orgId=1\nSilence: https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\u0026matcher=__alert_rule_uid__%3Deewi8oa4ccef4e\u0026matcher=datasource_uid%3Dgrafanacloud-prom\u0026matcher=ref_id%3DA\u0026matcher=rulename%3Dviable%2Fstrict+is+broken\u0026orgId=1\nDashboard: https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\u0026orgId=1\u0026to=1758042776758\nPanel: https://pytorchci.grafana.net/d/e9a2a2e9-66d8-4ae3-ac6a-db76ab17321c?from=1758039140000\u0026orgId=1\u0026to=1758042776758\u0026viewPanel=1\n"
}
```

## A second grana alert (after removing body from the envelop)
Another Grafana alert's body, with all double slashes escaped to single slash (the remaining ones probably started off as double slashes I'm guessing, or were added by a second system):

```json
{
  "receiver": "\\[DEVELOPMENT\\] TEST AWS webhook alerting system",
  "status": "firing",
  "alerts": [
    {
      "status": "firing",
      "labels": {
        "alertname": "TEST Alert that keeps toggling ~every 1 min",
        "grafana_folder": "TEST - alerts just for testing"
      },
      "annotations": {
        "CustomAnnotationPriority": "CustomAnnotationLow",
        "TEAM": "pytorch-dev-infra",
        "description": "TEST_DESCRIPTION:   This alert keeps toggling every minute.  If it fires, time has progressed",
        "runbook_url": "www.time.com",
        "summary": "TEST_SUMMARY: This alert keeps toggling every minute."
      },
      "startsAt": "2025-09-16T17:19:40Z",
      "endsAt": "0001-01-01T00:00:00Z",
      "generatorURL": "https://pytorchci.grafana.net/alerting/grafana/fex6jh8jaew3kc/view?orgId=1",
      "fingerprint": "3201e9e1f14b433c",
      "silenceURL": "https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\u0026matcher=__alert_rule_uid__%3Dfex6jh8jaew3kc\u0026orgId=1",
      "dashboardURL": "https://pytorchci.grafana.net/d/725e0bae-d10f-458e-a383-10cee2b4eacc?from=1758039580000\u0026orgId=1\u0026to=1758043210357",
      "panelURL": "https://pytorchci.grafana.net/d/725e0bae-d10f-458e-a383-10cee2b4eacc?from=1758039580000\u0026orgId=1\u0026to=1758043210357\u0026viewPanel=1",
      "values": {
        "C": 1,
        "reducer": 1
      },
      "valueString": "[ var='C' labels={} value=1 ], [ var='reducer' labels={} value=1 ]",
      "orgId": 1
    }
  ],
  "groupLabels": {
    "alertname": "TEST Alert that keeps toggling ~every 1 min",
    "grafana_folder": "TEST - alerts just for testing"
  },
  "commonLabels": {
    "alertname": "TEST Alert that keeps toggling ~every 1 min",
    "grafana_folder": "TEST - alerts just for testing"
  },
  "commonAnnotations": {
    "CustomAnnotationPriority": "CustomAnnotationLow",
    "TEAM": "pytorch-dev-infra",
    "description": "TEST_DESCRIPTION:   This alert keeps toggling every minute.  If it fires, time has progressed",
    "runbook_url": "www.time.com",
    "summary": "TEST_SUMMARY: This alert keeps toggling every minute."
  },
  "externalURL": "https://pytorchci.grafana.net/",
  "version": "1",
  "groupKey": "{}/{__grafana_autogenerated__=\"true\"}/{__grafana_receiver__=\"[DEVELOPMENT
  ] TEST AWS webhook alerting system\"}:{alertname=\"TEST Alert that keeps toggling ~every 1 min\", grafana_folder=\"TEST - alerts just for testing\"}",
  "truncatedAlerts": 0,
  "orgId": 1,
  "title": "[FIRING:1] TEST Alert that keeps toggling ~every 1 min TEST - alerts just for testing ",
  "state": "alerting",
  "message": "**Firing**\n\nValue: C=1, reducer=1\nLabels:\n - alertname = TEST Alert that keeps toggling ~every 1 min\n - grafana_folder = TEST - alerts just for testing\nAnnotations:\n - CustomAnnotationPriority = CustomAnnotationLow\n - TEAM = pytorch-dev-infra\n - description = TEST_DESCRIPTION:   This alert keeps toggling every minute.  If it fires, time has progressed\n - runbook_url = www.time.com\n - summary = TEST_SUMMARY: This alert keeps toggling every minute.\nSource: https://pytorchci.grafana.net/alerting/grafana/fex6jh8jaew3kc/view?orgId=1\nSilence: https://pytorchci.grafana.net/alerting/silence/new?alertmanager=grafana\u0026matcher=__alert_rule_uid__%3Dfex6jh8jaew3kc\u0026orgId=1\nDashboard: https://pytorchci.grafana.net/d/725e0bae-d10f-458e-a383-10cee2b4eacc?from=1758039580000\u0026orgId=1\u0026to=1758043210357\nPanel: https://pytorchci.grafana.net/d/725e0bae-d10f-458e-a383-10cee2b4eacc?from=1758039580000\u0026orgId=1\u0026to=1758043210357\u0026viewPanel=1\n"
}
```
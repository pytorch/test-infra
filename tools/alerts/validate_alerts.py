import argparse
from collections import defaultdict
import json
import jsonschema
import copy

BASE_ALERT_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "AlertType": { "type": "string" },
            "AlertObject": { "type": "string" },
            "OncallTeams": { "type": "array", "items": { "type": "string" } },
            "OncallIndividuals": { "type": "array", "items": { "type": "string" } },
            "Flags": { "type": "array", "items": { "type": "string" } },
            "branch": { "type": "string" },
        },
        "additionalProperties": True,
        "required": ["AlertType", "AlertObject", "OncallTeams", "OncallIndividuals", "Flags", "branch"],
    }
}

EXTRA_PROPERTIES = {
    "RecurentlyFailingJobAlert" : {
            "sha": { "type": "string" },
        },
    "ThresholdAlert" : {
        "MeasurementName": { "type": "string" },
        "ThresholdDescription": { "type": "string" },
        },
    "QueryAlert" : {
        "Machine": { "type": "string" },
        "Count": { "type": "number" },
        "Hours": { "type": "number" },
        }
    }

def validate_json(json_string):
    try:
        json_object = json.loads(json_string)
        print("The input string is a valid JSON.")
    except ValueError as e:
        raise ValueError(f"The input string is not a valid JSON: Error: {e}")
def validate_schema(json_string):
    all_alerts_schemas = defaultdict(lambda: copy.deepcopy(BASE_ALERT_SCHEMA))
    for alert_type, alert_schema_add_on in EXTRA_PROPERTIES.items():
        all_alerts_schemas[alert_type]["items"]["properties"].update(alert_schema_add_on)
        all_alerts_schemas[alert_type]["items"]["additionalProperties"] = False
        for property in alert_schema_add_on.keys():
            all_alerts_schemas[alert_type]["items"]["required"].append(property)
    json_object = json.loads(json_string)
    for alert in json_object:
        jsonschema.validate(instance=[alert], schema=all_alerts_schemas[alert["AlertType"]])


def main():
    parser = argparse.ArgumentParser(description="Validate json string containing alerts")
    parser.add_argument('--alerts', type=str, required=True, help="JSON string to validate.")
    args = parser.parse_args()
    validate_json(args.alerts)
    validate_schema(args.alerts)

if __name__ == '__main__':
    main()

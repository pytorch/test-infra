import argparse
import json
import jsonschema

ALERT_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "AlertType": { "type": "string" },
            "AlertObject": { "type": "string" },
            "OncallTeams": { "type": "array", "items": { "type": "string" } },
            "OncallIndividuals": { "type": "array", "items": { "type": "string" } },
            "Flags": { "type": "array", "items": { "type": "string" } },
        }
    }
}

def validate_json(json_string):
    try:
        json_object = json.loads(json_string)
        print("The input string is a valid JSON.")
    except ValueError as e:
        raise ValueError(f"The input string is not a valid JSON: Error: {e}")
def validate_schema(json_string):
    json_object = json.loads(json_string)
    jsonschema.validate(instance=json_object, schema=ALERT_SCHEMA)


def main():
    parser = argparse.ArgumentParser(description="Validate json string containing alerts")
    parser.add_argument('--alerts', type=str, required=True, help="JSON string to validate.")
    args = parser.parse_args()
    print(args.alerts)
    validate_json(args.alerts)
    validate_schema(args.alerts)

if __name__ == '__main__':
    main()

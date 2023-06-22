from unittest import TestCase, main
import json
import jsonschema
import tools.alerts.validate_alerts as validate_alerts

# valid json data
valid_json = json.dumps([
    {
        "AlertType": "Foo",
        "AlertObject": "Bar",
        "OncallTeams": ["Team1", "Team2"],
        "OncallIndividuals": ["Individual1", "Individual2"],
        "branch": "main",
        "Flags": ["Flag1", "Flag2"]
    },
    {
        "AlertType": "FooBar",
        "AlertObject": "BarFoo",
        "OncallTeams": ["Team1", "Team2"],
        "OncallIndividuals": ["Individual1", "Individual2"],
        "branch": "main",
        "Flags": ["Flag1", "Flag2"]
    }
])

# invalid json data
invalid_json = '{"invalid_json"}'

# valid json but invalid schema
valid_json_invalid_schema = json.dumps([{
    "AlertType": "Foo",
    "AlertObject": "Bar",
    "OncallTeams": "Team1",  # should be list
    "OncallIndividuals": ["Individual1", "Individual2"],
    "Flags": ["Flag1", "Flag2"]
}])

valid_json_valid_recurrently_failing_job_alert_schema = json.dumps([{
    "AlertType": "RecurentlyFailingJobAlert",
    "AlertObject": "Bar",
    "OncallTeams": ["Team1", "Team2"],
    "OncallIndividuals": ["Individual1", "Individual2"],
    "Flags": ["Flag1", "Flag2"],
    "branch": "main",
    "sha": "1234567890123456789012345678901234567890"
}   ,
{
    "AlertType": "FooBar",
    "AlertObject": "BarFoo",
    "OncallTeams": ["Team1", "Team2"],
    "OncallIndividuals": ["Individual1", "Individual2"],
    "branch": "main",
    "Flags": ["Flag1", "Flag2"]
}])

valid_json_invalid_recurrently_failing_job_alert_schema = json.dumps([{
    "AlertType": "RecurentlyFailingJobAlert",
    "AlertObject": "Bar",
    "OncallTeams": ["Team1", "Team2"],
    "OncallIndividuals": ["Individual1", "Individual2"],
    "Flags": ["Flag1", "Flag2"],
    "branch": "main",
}])
    


class AlertValidationTest(TestCase):
    def test_validate_json(self):
        # Test whether valid json is correctly validated
        assert validate_alerts.validate_json(valid_json) is None

        # Test whether invalid json raises an error
        with self.assertRaises(ValueError):
            validate_alerts.validate_json(invalid_json)

    def test_validate_schema(self):
        # Test whether valid json that conforms to the schema is correctly validated
        assert validate_alerts.validate_schema(valid_json) is None

        # Test whether valid json that does not conform to the schema raises an error
        with self.assertRaises(jsonschema.exceptions.ValidationError):
            validate_alerts.validate_schema(valid_json_invalid_schema)
    
    def test_validate_recurrently_failing_job_alert_schema(self):
        # Test whether valid json that conforms to the schema is correctly validated
        assert validate_alerts.validate_schema(valid_json_valid_recurrently_failing_job_alert_schema) is None

        # Test whether valid json that does not conform to the schema raises an error
        with self.assertRaises(jsonschema.exceptions.ValidationError):
            validate_alerts.validate_schema(valid_json_invalid_recurrently_failing_job_alert_schema)

if __name__ == '__main__':
    main()

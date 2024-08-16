# Log Classifier Data Preparation

This guide explains how to download logs for improving our log classifier.

## Prerequisites

- Python 3.x
- Access to the required AWS Lambda and ClickHouse resources

## Downloading Logs

Use the following script to download a sample of logs:

```bash
cd test-infra/aws/lambda/log-classifier
python scripts/download_logs.py <data_file_location> <num_logs> <save_location>
```

There is already a datafile located in `test-infra/aws/lambda/log-classifier/data/log_classifier_dataset_query_2024-08-14.csv`

### Example
`python scripts/download_logs.py data/log_classifier_dataset_query_2024-08-14.csv 10 data/dataset`

### Creating a Data File
To generate a new data file:

Access the ClickHouse database
Run the log_classifier_dataset_query
Export the results as a CSV file
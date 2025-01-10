import requests
import argparse
import random
import json
import os


def read_log_dataset(file_location):
    """
    Reads a log dataset from a CSV file and returns a list of dictionaries.
    The CSV file should have the following schema:
    "id","startTime","conclusion","dynamoKey","name","job_name"

    Args:
        file_location (str): The location of the log dataset CSV file.

    Returns:
        list: A list of dictionaries, where each dictionary represents a log entry.
              Each dictionary contains the following keys:
              - "id": The ID of the log
              - "startTime": The start time of the log
              - "conclusion": The conclusion of the log
              - "repo": The repository name extracted from the "dynamoKey" field
              - "job_name": The name of the job

    Raises:
        ValueError: If the CSV file does not have the expected schema.
    """
    with open(file_location, "r") as file:
        lines = file.readlines()
        data = []
        for line in lines[1:]:
            parts = line.strip().split(",")
            if len(parts) != 6:
                raise ValueError(f"Invalid CSV schema. Expected 6 columns. with entry {parts}")
            parts = [part.strip('"') for part in parts]
            data.append({
                "id": parts[0],
                "startTime": parts[1],
                "conclusion": parts[2],
                "repo": parts[3].split("/")[-1],
                "job_name": parts[5],
            })
        return data


def download_log(save_location, job_id):
    """
    Downloads the log content from the specified job ID and saves it to a file.
    The location of the file is determined by the "save_location" argument.
    The file will be saved with the name "<job_id>.txt".

    Args:
        save_location (str): The directory where the log file will be saved.
        job_id (str): The ID of the job whose log will be downloaded.

    Raises:
        requests.exceptions.RequestException: If an error occurs during the HTTP request.

    Returns:
        None
    """
    base_url = "https://ossci-raw-job-status.s3.amazonaws.com/log/"
    url = f"{base_url}{job_id}"
    try:
        # Send a GET request to the URL
        response = requests.get(url)
        # Check if the request was successful
        response.raise_for_status()
        # Get the content
        content = response.text
        # Save the content to a file
        # create a folder called dataset if it doesn't exist
        with open(f"{save_location}/{job_id}.txt", "w", encoding="utf-8") as file:
            file.write(content)
    except requests.exceptions.RequestException as e:
        print(f"An error occurred: {e}")


if __name__ == "__main__":

    parser = argparse.ArgumentParser(description="Download logs from log dataset")
    parser.add_argument("log_dataset_location", help="Location of the log dataset")
    parser.add_argument("num_logs", type=int, help="Number of logs to download")
    parser.add_argument("save_location", help="Location to save the logs")

    args = parser.parse_args()

    # if save location doesn't exist, create it
    if not os.path.exists(args.save_location):
        os.makedirs(args.save_location)
    # if there is content in the save location, raise an error and ask the user to delete the content
    if os.listdir(args.save_location):
        raise ValueError(f"The save location is not empty. Please delete the content before running the script. You can run the following command to delete the content:\n rm -rf {args.save_location}/*")

    data = read_log_dataset(args.log_dataset_location)

    # select a random sample of the data
    data = random.sample(data, args.num_logs)

    # add save location to data dictionary
    for item in data:
        item["save_location"] = f"{args.save_location}/{item['id']}.txt"

    for item in data[:args.num_logs]:
        print(f"Downloading log for job ID: {item['id']}")
        download_log(args.save_location, item["id"])

    # save the random data to a file in the save location as metadata in json format pretty printed

    with open(f"{args.save_location}/metadata.json", "w") as file:
        json.dump(data, file, indent=4)

#!/usr/bin/env python3
# Download AWS lambas from all regions
# Copyright (c) 2021-present, Facebook, Inc.
import boto3
import os
import tempfile
import urllib
import zipfile


def download_lambda(client, name, basename="."):
    url = client.get_function(FunctionName=name)['Code']['Location']
    print(f"Downloading {name}")
    with tempfile.NamedTemporaryFile(suffix='.zip') as tmp:
        urllib.request.urlretrieve(url, tmp.name)
        with zipfile.ZipFile(tmp.name) as zip:
            os.makedirs(os.path.join(basename, name))
            zip.extractall(os.path.join(basename, name))


def get_function_names(client):
    return [function['FunctionName'] for function in client.list_functions()['Functions']]


def get_region_list():
    ec2 = boto3.client("ec2")
    return [r['RegionName'] for r in ec2.describe_regions()['Regions']]


if __name__ == '__main__':
    for region in get_region_list():
        client = boto3.client("lambda", region_name=region)
        functions = get_function_names(client)
        if len(functions) == 0:
            print(f"Region {region} has no lambdas")
            continue
        for function in functions:
            download_lambda(client, function, region)

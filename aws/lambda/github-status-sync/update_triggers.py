import json
import os
import boto3
import click

eb = boto3.client("events")
lb = boto3.client("lambda")


def jprint(o):
    print(json.dumps(o, indent=2, default=str))


REGION = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
ACCOUNT_ID = os.environ["ACCOUNT_ID"]
LAMBDA_ARN = f"arn:aws:lambda:{REGION}:{ACCOUNT_ID}:function:ossci-job-status-sync"


def generate_input(repo, branches, user="pytorch", history_size=100, fetch_size=10):
    return {
        "branches": ",".join(branches),
        "user": user,
        "repo": repo,
        "history_size": history_size,
        "fetch_size": fetch_size,
    }


EVENT_TARGETS = {
    "sync-pytorch-audio": {
        "schedule": "rate(1 hour)",
        "input": generate_input(repo="audio", branches=["main", "nightly", "release/0.10"]),
    },
    "sync-pytorch-examples": {
        "schedule": "rate(4 hours)",
        "input": generate_input(repo="examples", branches=["master"]),
    },
    "sync-pytorch-tutorials": {
        "schedule": "rate(4 hours)",
        "input": generate_input(repo="tutorials", branches=["master"]),
    },
    "sync-pytorch-text": {
        "schedule": "rate(2 hours)",
        "input": generate_input(repo="text", branches=["main", "nightly", "release/0.11"]),
    },
    "sync-pytorch-vision": {
        "schedule": "rate(1 hour)",
        "input": generate_input(repo="vision", branches=["main", "nightly", "release/0.11"]),
    },
    "sync-pytorch-pytorch": {
        "schedule": "rate(1 minute)",
        "input": generate_input(repo="pytorch", branches=["master"]),
    },
    "sync-pytorch-pytorch-slow": {
        "schedule": "rate(1 hour)",
        "input": generate_input(
            repo="pytorch", branches=["nightly", "viable/strict", "release/1.11"],
        ),
    },
    "sync-pytorch-lightning": {
        "schedule": "rate(4 hours)",
        "input": generate_input(
            user="PyTorchLightning",
            repo="pytorch-lightning",
            branches=["master"],
            fetch_size=4,
        ),
    },
    "sync-pytorch-torchx": {
        "schedule": "rate(4 hours)",
        "input": generate_input(repo="torchx", branches=["main"],),
    },
}


@click.group()
def cli():
    """
    Tool to manage CloudEvents triggers for the syncing job behind hud.pytorch.org.

    To use, you must set the ACCOUNT_ID environment variable:

    # You can also get the ID from any ARN on the account
    $ aws sts get-caller-identity --query Account --output text
    123456
    $ export ACCOUNT_ID=123456
    """
    pass


@cli.command()
@click.option("--rule")
def invoke(rule):
    data = EVENT_TARGETS[rule]["input"]
    print(f"Sending to {LAMBDA_ARN}:")
    print(json.dumps(data, indent=2))
    result = lb.invoke(FunctionName=LAMBDA_ARN, Payload=json.dumps(data).encode())
    print(result)


@cli.command()
def list():
    """
    Show all triggering rules for the lambda
    """
    rules = eb.list_rule_names_by_target(TargetArn=LAMBDA_ARN)["RuleNames"]
    for name in rules:
        targets = eb.list_targets_by_rule(Rule=name)
        for target in targets["Targets"]:
            input = json.loads(target["Input"])
            print(f"Input for {name} ({target['Id']}):")
            jprint(input)
            print("")


@cli.command()
def update():
    """
    Remove and re-add all triggering rules for the lambda
    """
    rules = eb.list_rule_names_by_target(TargetArn=LAMBDA_ARN)["RuleNames"]
    for name in rules:
        # Clear out targets
        targets = eb.list_targets_by_rule(Rule=name)
        ids = [t["Id"] for t in targets["Targets"]]
        eb.remove_targets(Rule=name, Ids=ids)

        # Delete the rule
        eb.delete_rule(Name=name)
        print(f"Deleted rule {name}")

    # Add the rules specified above
    for name, data in EVENT_TARGETS.items():
        eb.put_rule(Name=name, ScheduleExpression=data["schedule"], State="ENABLED")

        # Install a target on the rule
        r = eb.put_targets(
            Rule=name,
            Targets=[
                {"Arn": LAMBDA_ARN, "Id": "update", "Input": json.dumps(data["input"])}
            ],
        )
        if r["FailedEntryCount"] == 0:
            print(f"Updated {name}")
        else:
            print(f"Failed to update {name}")


if __name__ == "__main__":
    cli()

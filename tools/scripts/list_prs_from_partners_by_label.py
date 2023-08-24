"""
Generates html pages that categorizes currently opened PRs in pytorch/pytorch repo.

Fetches the list of opened PRs, automatically classifies their authors based on rules
and generate the aggregated HTML views.

Parameters (env variables):

GITHUB_TOKEN: private GH token (is used to check org membership of the authors, e.g. fairinternal and pytorch)
CACHE: boolean (false by default) cache fetched information locally in files, for quick iteration on the generated htmls

Script typically takes around 10 minutes to run.
"""

import json
import os

import requests

token = os.environ.get("GITHUB_TOKEN")
local_cache = os.environ.get("CACHE")

if not token:
    print("GITHUB_TOKEN env variable is required")
    exit(1)

headers = {"Authorization": f"token {token}"}

"""
Fetch all prs
"""
all_prs = []
if os.path.exists("prs.json"):
    with open("prs.json", "r") as f:
        all_prs = json.load(f)
else:
    page = 1
    # request with &page=1 ... &page=n
    while True:
        print(f"Fetching page {page}")
        r = requests.get(
            f"https://api.github.com/repos/pytorch/pytorch/pulls?state=open&per_page=100&page={page}",
            headers=headers,
        )
        if r.status_code != 200:
            print(f"Error: {r.status_code}")
            exit(1)
        prs_json = r.json()
        if len(prs_json) == 0:
            break
        all_prs += prs_json
        page += 1

    if local_cache:
        # save filtered PRs to json file
        with open("prs.json", "w") as f:
            json.dump(all_prs, f)

# get all PR authors
authors = set()
for pr in all_prs:
    authors.add(pr["user"]["login"])

# fetch and cache pr authors
if os.path.exists("authors.json"):
    with open("authors.json", "r") as f:
        authors_dict = json.load(f)
else:
    authors_dict = {}
    for author in authors:
        print(f"Fetching {author}")
        r = requests.get(f"https://api.github.com/users/{author}", headers=headers)
        if r.status_code != 200:
            print(f"Error: {r.status_code}")
            exit(1)
        authors_dict[author] = r.json()

    if local_cache:
        # save filtered PRs to json file
        with open("authors.json", "w") as f:
            json.dump(authors_dict, f)

# fetch and cache orgs of the authors
if os.path.exists("orgs.json"):
    with open("orgs.json", "r") as f:
        orgs_dict = json.load(f)
else:
    orgs_dict = {}
    for author in authors:
        print(f"Fetching orgs for {author}")
        r = requests.get(f"https://api.github.com/users/{author}/orgs", headers=headers)
        if r.status_code != 200:
            print(f"Error: {r.status_code}")
            exit(1)
        # save list of logins
        orgs_dict[author] = [org["login"] for org in r.json()]

    if local_cache:
        # save filtered PRs to json file
        with open("orgs.json", "w") as f:
            json.dump(orgs_dict, f)


def is_org_member(user, org):
    """
    Checks org membership for GH user
    :param user: gh user login
    :param org: gl org login
    :return: True if user belongs to the org, False otherwise
    """
    r = requests.get(
        f"https://api.github.com/orgs/{org}/members/{user}", headers=headers
    )
    if r.status_code == 204:
        return True
    elif r.status_code == 302 or r.status_code == 404:
        return False
    else:
        print(f"membership check for user {user} failed, code: {r.status_code}")
        exit(1)


# classify authors as org members and cache
org_membership = {}
if os.path.exists("org_membership.json"):
    with open("org_membership.json", "r") as f:
        org_membership = json.load(f)
else:
    for author in authors:
        org_membership[author] = list()
        print(f"Fetching org membership for {author}")
        if is_org_member(author, "fairinternal"):
            org_membership[author].append("fairinternal")
        if is_org_member(author, "pytorch"):
            org_membership[author].append("pytorch")

    if local_cache:
        # save filtered PRs to json file
        with open("org_membership.json", "w") as f:
            json.dump(org_membership, f)

overrides = {}


def classify_author(user):
    """
    :param user:
    :return: str company-based category, i.e. 'meta' 'apple', 'other:...', 'unknown'
    """
    if user in overrides:
        return overrides[user]

    if "fairinternal" in org_membership.get(user, []):
        return "meta"

    if user in authors_dict:
        if authors_dict[user].get("company") is not None:
            company = authors_dict[user]["company"].lower()

            if "facebook" in company or "meta" in company:
                return "meta"
            if "google" in company:
                return "google"
            elif "nvidia" in company:
                return "nvidia"
            elif "intel" in company:
                return "intel"
            elif "microsoft" in company:
                return "microsoft"
            elif "apple" in company:
                return "apple"
        if user in orgs_dict:
            # if 'pytorch' in orgs_dict[author]:
            #     return 'meta'
            if "NVIDIA" in orgs_dict[user]:
                return "nvidia"
            elif "Intel" in orgs_dict[user]:
                return "intel"
            elif "Microsoft" in orgs_dict[user]:
                return "microsoft"
            elif "Apple" in orgs_dict[user]:
                return "apple"
        # check email
        if isinstance(authors_dict[user].get("email"), str):
            if "nvidia" in authors_dict[user]["email"]:
                return "nvidia"
            if "meta.com" in authors_dict[user]["email"]:
                return "meta"
            if "fb.com" in authors_dict[user]["email"]:
                return "meta"
            elif "intel" in authors_dict[user]["email"]:
                return "intel"
            elif "microsoft" in authors_dict[user]["email"]:
                return "microsoft"
            elif "apple" in authors_dict[user]["email"]:
                return "apple"

        if isinstance(authors_dict[user].get("company"), str):
            return f'other: {authors_dict[user]["company"]}'

    return "unknown"


def cla_signed(pr_id):
    """
    Returns Linux Foundation CLA status for the PR.
    Fetches information by scanning PR comments for the CLA status from the linux-foundation-easycla[bot]
    :param pr_id: PR number (any type)
    :return: True if CLA is signed, False if not signed, None if no CLA information is present
    """
    # fetch comments
    r = requests.get(
        f"https://api.github.com/repos/pytorch/pytorch/issues/{pr_id}/comments?per_page=100",
        headers=headers,
    )
    if r.status_code != 200:
        print(f"Error: {r.status_code}")
        exit(1)
    comments = r.json()
    for comment in comments:
        if comment["user"]["login"] == "linux-foundation-easycla[bot]":
            if ":white_check_mark:" in comment["body"]:
                return True
            elif ":x:" in comment["body"]:
                return False
    return None


# cache cla status for all prs
if os.path.exists("cla_status.json"):
    with open("cla_status.json", "r") as f:
        cla_status = json.load(f)
else:
    cla_status = {}
    for pr in all_prs:
        cla = cla_signed(pr["number"])
        cla_status[str(pr["number"])] = cla
        print(f'cla status for #{pr["number"]} is {cla}')

    if local_cache:
        # save filtered PRs to json file
        with open("cla_status.json", "w") as f:
            json.dump(cla_status, f)


def link(text, url):
    return f'<a href="{url}">{text}</a>'


def generate_table_by_feature(labels_order):
    """
    generate html table with the list of PRs
    that have labels that starts with "release notes:"
    group by label, company, author
    sort by date
    :param labels_order: list of labels to display at the top. Use None as a catch-all 'else' clause
    :return: generated html
    """
    # get all PRs with release notes labels
    release_notes_prs = []
    for pr in all_prs:
        for label in pr["labels"]:
            if label["name"].startswith("release notes:"):
                release_notes_prs.append(pr)
                break

    # group by label
    release_notes_prs_by_label = {}
    for pr in release_notes_prs:
        for label in pr["labels"]:
            if label["name"].startswith("release notes:"):
                release_notes_prs_by_label.setdefault(label["name"], []).append(pr)

    # group by label and company
    release_notes_prs_by_label_and_company = {}
    for label, prs in release_notes_prs_by_label.items():
        for pr in prs:
            company = classify_author(pr["user"]["login"])
            release_notes_prs_by_label_and_company.setdefault(label, {}).setdefault(
                company, []
            ).append(pr)

    # sort by date
    for label, companies in release_notes_prs_by_label_and_company.items():
        for company, prs in companies.items():
            prs.sort(key=lambda pr: pr["created_at"])

    # generate html table
    html = """
    <!DOCTYPE html>
    <html lang="en" data-color-mode="auto">
      <head><meta charset="utf-8"></head><body><table>
        """
    for lo in labels_order:
        for label, companies in release_notes_prs_by_label_and_company.items():
            if (
                lo is None
                and any(l is not None and l in label for l in labels_order)
                or lo is not None
                and lo not in label
            ):
                continue

            # include pr number, CLA status and all the links
            html += f'<tr><td colspan="4"><h1>{label}</h1></td></tr>'
            for company, prs in companies.items():
                html += f'<tr><td colspan="4"><b>{company}</b></td></tr>'
                for pr in prs:
                    cla = cla_status.get(str(pr["number"]))
                    if company == "meta":
                        cla = True

                    html += (
                        "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                            pr["created_at"][:10],
                            link(pr["user"]["login"], pr["user"]["html_url"]),
                            "✅" if cla else ("❌" if cla is False else "❓"),
                            link(f'#{pr["number"]} {pr["title"]}', pr["html_url"]),
                        )
                    )
            html += '<tr><td colspan="4">&nbsp;</td></tr>'
    html += "</table></body></html>"
    return html


def generate_table_by_authors():
    """
    Generate html table of classified authors with profile links and link to the list of their PRs in
    pytorch/pytorch repo.
    :return: generated html
    """
    rows = []
    for author in authors:
        num_prs = len([pr for pr in all_prs if pr["user"]["login"] == author])

        rows.append(
            "<tr><td>{}</td><td>{}</td><td>{}</td><td>{}</td></tr>".format(
                classify_author(author),
                link(author, authors_dict[author]["html_url"]),
                link(
                    f"{num_prs}",
                    f"https://github.com/pytorch/pytorch/pulls?q=is%3Apr+is%3Aopen+author%3A{author}",
                ),
                "✓" if "pytorch" in org_membership.get(author, []) else "",
            )
        )

    # sort rows by category, put 'meta' and 'unknown' at the end
    rows = sorted(rows, key=lambda row: row.split("<td>")[1])
    rows = [row for row in rows if "unknown" not in row] + [
        row for row in rows if "unknown" in row
    ]
    rows = [row for row in rows if "individual" not in row] + [
        row for row in rows if "individual" in row
    ]
    rows = [row for row in rows if "meta" not in row] + [
        row for row in rows if "meta" in row
    ]

    # generate html table
    html = """
    <!DOCTYPE html>
    <html lang="en" data-color-mode="auto">
      <head><meta charset="utf-8"></head><body><table>
        """
    html += (
        "<tr><th>Company</th><th>Author</th><th>PRs</th><th>pytorch member</th></tr>"
    )
    html += "\n".join(rows)
    html += "</table></body></html>"
    return html


with open("prs_by_author.html", "w") as f:
    f.write(generate_table_by_feature(["mps", "onnx", "cuda", None]))

with open("prs_by_label.html", "w") as f:
    f.write(generate_table_by_authors())

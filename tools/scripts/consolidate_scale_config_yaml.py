#!/usr/bin/env python3

'''
GHS: org:pytorch path:.github filename:scale-config.yml

$ pip install requests pyyaml
$ python tools/scripts/consolidate_scale_config_yaml.py -o pytorch -r torchsnapshot multipy pytorch-canary torchdynamo PiPPy benchmark_private torchrec FBGEMM pytorch.github.io builder
'''

import argparse
import requests
import sys
import time
import yaml


SCALE_CFG_PATH='.github/scale-config.yml'


def get_arguments():
    parser = argparse.ArgumentParser(description=f'Consolidate {SCALE_CFG_PATH} files from multiple repos.')
    parser.add_argument(
        '-r', '--repos',
        type=str,
        nargs='+',
        required=True,
        help=f'repositories to scan for "{SCALE_CFG_PATH}" file for consolidation'
    )
    parser.add_argument(
        '-o', '--org',
        type=str,
        required=True,
        help='gihub organization the repositories belong to'
    )
    parser.add_argument(
        '-u', '--user',
        type=str,
        required=False,
        default=None,
        help='github user'
    )
    parser.add_argument(
        '-t', '--token',
        type=str,
        required=False,
        default=None,
        help='github password'
    )

    return parser.parse_args()


def get_repo_scale_cfg(org, repo, user, token):
    for branch in ('master', 'main', 'site', ):
        url = f'https://raw.githubusercontent.com/{org}/{repo}/{branch}/{SCALE_CFG_PATH}'
        wait_time = 10
        while True:
            if user and token:
                response = requests.get(url, auth=requests.auth.HTTPBasicAuth(user, token))
            else:
                response = requests.get(url)
            if response.status_code == 200:
                return yaml.full_load(response.text)
            else:
                if 'X-RateLimit-Used' not in response.headers:
                    break
                else:
                    print(f'Exceeded github rate limit, waiting {wait_time}s')
                    time.sleep(wait_time)
                    wait_time += 10
    raise Exception(f'Could not find "{SCALE_CFG_PATH}" for {org}/{repo}')


def check_being_used(org, repo, name, user, token):
    url = 'https://api.github.com/search/code'
    query = {
        'q': f'{name} in:file path:.github repo:{org}/{repo}'
    }
    wait_time = 10
    while True:
        if user and token:
            response = requests.get(url, params=query, auth=requests.auth.HTTPBasicAuth(user, token))
        else:
            response = requests.get(url, params=query)
        if response.status_code != 200:
            if 'X-RateLimit-Used' not in response.headers:
                raise Exception(f'Unexpected response! {response}')
            else:
                print(f'Exceeded github rate limit, waiting {wait_time}s')
                time.sleep(wait_time)
                wait_time += 10
        else:
            break

    obj = response.json()

    found = {}
    for ocurrence in obj['items']:
        if ocurrence['path'] != SCALE_CFG_PATH:
            found[ocurrence['path']] = 1
    if len(found) > 0:
        return True
    print(f'No usage found for {name} in {org}/{repo} = {query["q"]}', file=sys.stderr)
    return False

def show_error(msg, k, v, repo, type_warning, consolidated):
    os, is_ephemeral, ref_repo = type_warning[v['instance_type']][k]
    print(msg, file=sys.stderr)
    print(f'''
######################
Error: {msg}
Details:
    {v["instance_type"]} - {k}
      - 'CONSOLIDATED' - {consolidated[k]}
      - {repo} - {v} - {type_warning[consolidated[k]["instance_type"]]}
      - {ref_repo} - {type_warning[v["instance_type"]]}
######################
''', file=sys.stderr)
    raise Exception(msg)


def main():
    args = get_arguments()

    consolidated = {'runner_types': {}}
    type_warning = {}
    errors_list = []

    for repo in args.repos:
        try:
            scale_cfg = get_repo_scale_cfg(args.org, repo, args.user, args.token)
        except Exception as e:
            errors_list.append(e)

        for k, v in scale_cfg['runner_types'].items():

            found_in_repo = False
            sleep_times = [30, 60, 5, ]
            for sleep_time in sleep_times:
                if check_being_used(args.org, repo, k, args.user, args.token):
                    found_in_repo = True
                    break
                print(f'WARNING! Found a instance_type ({k}) that seems to not be used in repo {args.org}/{repo} (will repeat, as it can be rate limiting)')
                time.sleep(sleep_time)

            if not found_in_repo:
                print(f'WARNING! Found a instance_type ({k}) that seems to not be used in repo {args.org}/{repo} REALLY IGNORED!', file=sys.stderr)
                continue

            try:
                if 'is_ephemeral' not in v:
                    v['is_ephemeral'] = False

                if v['instance_type'] in type_warning:
                    if k in type_warning[v['instance_type']]:
                        os, is_ephemeral, ref_repo = type_warning[v['instance_type']][k]
                        if os != v['os'] or is_ephemeral != v['is_ephemeral']:
                            print(f'WARNING! Found runner_types with same name && instance_type [{v["instance_type"]}, {k}] but different OS or is_ephemeral tag, this will fail [({ref_repo}, {os}, {is_ephemeral}), ({repo}, {v["os"]}, {v["is_ephemeral"]})]', file=sys.stderr)
                    else:
                        # multiple places using same instance type with different names, if they are using differnt config, then it is fine, otherwise warn
                        for runn_type, runn_cfg in type_warning[v['instance_type']].items():
                            os, is_ephemeral, ref_repo = runn_cfg
                            if os != v['os'] or is_ephemeral != v['is_ephemeral']:
                                print(f'INFO! Found runner_types with same instance_type [{v["instance_type"]}, {k}] and different OS or is_ephemeral tag, this is not encouraged, but it is OK [({ref_repo}, {os}, {is_ephemeral}), ({repo}, {v["os"], v["is_ephemeral"]})]')
                            else:
                                print(f'WARNING! Found runner_types with same instance_type [{v["instance_type"]}, {k}] and same OS or is_ephemeral tags, but they have different names, this is bad [({ref_repo}, {os}, {is_ephemeral}), ({repo}, {v["os"], v["is_ephemeral"]})]', file=sys.stderr)
                else:
                    type_warning[v['instance_type']] = {
                        k: (v['os'], v['is_ephemeral'], repo ),
                    }

                if k in consolidated['runner_types']:
                    if consolidated['runner_types'][k]['instance_type'] != v['instance_type']:
                        show_error('Runners with same name MUST have same instance_type', k, v, repo, type_warning, consolidated['runner_types'])
                    if consolidated['runner_types'][k]['is_ephemeral'] != v['is_ephemeral']:
                        show_error('Runners with same name MUST have same is_ephemeral flag', k, v, repo, type_warning, consolidated['runner_types'])
                    if consolidated['runner_types'][k]['os'] != v['os']:
                        show_error('Runners with same name MUST have same os', k, v, repo, type_warning, consolidated['runner_types'])

                    consolidated['runner_types'][k]['disk_size'] = max([
                        consolidated['runner_types'][k]['disk_size'],
                        v['disk_size'],
                    ])
                    consolidated['runner_types'][k]['max_available'] = sum([
                        consolidated['runner_types'][k]['max_available'],
                        v['max_available'],
                    ])

                else:
                    consolidated['runner_types'][k] = v
            except Exception as e:
                errors_list.append(e)

    if errors_list:
        print('*************************************************', file=sys.stderr)
        for error in errors_list:
            print(error, file=sys.stderr)

    print('*************************************************', file=sys.stderr)
    print(yaml.dump(consolidated, default_flow_style=False, sort_keys=True))


if __name__ == '__main__':
    main()

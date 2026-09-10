-- Cost by fleet. Region/fleet is inferred from the runner type (runner_cost has no region column); approximate.
select
    DATE_TRUNC({granularity: String}, rc.date) as granularity_bucket,
    multiIf(rc.runner_type like 'mt-%', 'OSDC/ciforge', rc.provider = 'github', 'GitHub-hosted', rc.owning_account = 'linux_foundation', 'Linux Foundation', 'Regular EC2') as fleet,
    sum(rc.cost) as total_cost
from
    misc.runner_cost rc final
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.cost > 0
    and rc.group_repo in {selectedRepos: Array(String)}
    and rc.gpu in {selectedGPU: Array(UInt8)}
    and rc.os in {selectedPlatforms: Array(String)}
    and rc.provider in {selectedProviders: Array(String)}
    and rc.owning_account in {selectedOwners: Array(String)}
group by
    granularity_bucket,
    fleet
order by
    granularity_bucket asc

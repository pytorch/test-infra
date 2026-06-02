select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    rc.region as region,
    sum(rc.duration) as total_duration
from
    misc.runner_cost rc final
where
    rc.date > {startTime: DateTime64(9)}
    and rc.date < {stopTime: DateTime64(9)}
    and rc.duration > 0
    and rc.group_repo in {selectedRepos: Array(String)}
    and rc.gpu in {selectedGPU: Array(UInt8)}
    and rc.os in {selectedPlatforms: Array(String)}
    and rc.provider in {selectedProviders: Array(String)}
    and rc.owning_account in {selectedOwners: Array(String)}
    and rc.region in {selectedRegions: Array(String)}
    and multiIf(rc.runner_type like 'mt-%', 'OSDC/ciforge', rc.provider = 'github', 'GitHub-hosted', rc.owning_account = 'linux_foundation', 'Linux Foundation', 'Regular EC2') in {selectedFleets: Array(String)}
group by
    granularity_bucket,
    region
order by
    granularity_bucket asc

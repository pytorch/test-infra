select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    rc.owning_account as owning_account,
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
group by
    granularity_bucket,
    owning_account
order by
    granularity_bucket asc

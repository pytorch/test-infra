select
    DATE_TRUNC(
        {granularity: String},
        rc.date
    ) as granularity_bucket,
    rc.workflow_name as workflow_name,
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
    workflow_name
order by
    granularity_bucket asc

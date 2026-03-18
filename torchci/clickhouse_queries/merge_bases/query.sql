select
    sha as head_sha,
    merge_base,
    merge_base_commit_date,
from
    merge_bases
where
    sha in {shas: Array(String)}
    and merge_base_commit_date != 0
    and repo = {repo: String}

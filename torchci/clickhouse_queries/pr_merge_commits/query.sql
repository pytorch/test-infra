SELECT
  pr_num,
  merge_commit_sha,
FROM
  default.merges final
WHERE
  pr_num in {pr_nums: Array(Int64)}
  AND owner = {owner: String}
  AND project = {project: String}
  AND merge_commit_sha != ''
ORDER BY
  comment_id DESC

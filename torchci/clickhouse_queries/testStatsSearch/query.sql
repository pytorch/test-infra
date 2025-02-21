select
    t.name,
    t.classname,
    t.file,
    t.invoking_file,
    maxMerge(t.last_run) as last_run
from
    tests.distinct_names t
where
    t.name like {name: String}
    and t.classname like {suite: String}
    and t.file like {file: String}
group by
    t.name,
    t.classname,
    t.file,
    t.invoking_file
order by
    t.name, t.classname, t.file, t.invoking_file
limit
    {per_page: Int}
    offset
    {offset: Int}

select
  count(distinct *) as count
from
  tests.distinct_names t
where
  t.name like {name: String}
  and t.classname like {suite: String}
  and t.file like {file: String}

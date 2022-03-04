select
    pr.title as title,
from
    pull_request pr
where
    pr.number = :pr
    AND pr.html_url LIKE CONCAT('https://github.com/', :owner, '/', :repo, '/%')

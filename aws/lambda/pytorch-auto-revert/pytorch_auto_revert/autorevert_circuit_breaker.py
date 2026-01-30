import logging

from .github_client_helper import GHClientFactory
from .utils import RetryWithBackoff


logger = logging.getLogger(__name__)


def check_autorevert_disabled(
    repo_full_name: str = "pytorch/pytorch",
    approved_users: set[str] | None = None,
) -> bool:
    """
    Check if autorevert is disabled by looking for open issues with 'ci: disable-autorevert' label.

    Note: Only actual GitHub issues are considered. Pull requests with this label are ignored,
    since the circuit breaker is meant for explicit manual disabling via issues.

    Security: Only issues created by users in the approved_users set can activate the circuit
    breaker. This prevents unauthorized users from disabling autorevert.

    Args:
        repo_full_name: Repository name in format 'owner/repo'
        approved_users: Set of GitHub usernames authorized to disable autorevert.
                       If None or empty, no authorization check is performed.

    Returns:
        True if autorevert should be disabled (circuit breaker active), False otherwise
    """
    try:
        for attempt in RetryWithBackoff():
            with attempt:
                gh_client = GHClientFactory().client
                repo = gh_client.get_repo(repo_full_name)

                should_disable = False

                # Search for open issues with the specific label
                # Note: GitHub API returns both issues and PRs via get_issues()
                disable_issues = repo.get_issues(
                    state="open", labels=["ci: disable-autorevert"]
                )

                for issue in disable_issues:
                    # Skip pull requests - only consider actual issues
                    if issue.pull_request is not None:
                        logger.debug(
                            f"Skipping PR #{issue.number} with 'ci: disable-autorevert' label. "
                            f"Circuit breaker only responds to issues, not PRs."
                        )
                        continue

                    # Check if user is authorized (if approved_users list is provided)
                    if approved_users and issue.user.login not in approved_users:
                        logger.warning(
                            f"Ignoring issue #{issue.number} with 'ci: disable-autorevert' label. "
                            f"User '{issue.user.login}' is not in the approved users list. "
                            f"Only approved users can disable autorevert via circuit breaker."
                        )
                        continue

                    logger.info(
                        f"Found open issue #{issue.number} with 'ci: disable-autorevert' label "
                        f"created by user {issue.user.login}. "
                        f"Autorevert circuit breaker is ACTIVE."
                    )
                    should_disable = True

                if should_disable:
                    return True

                logger.debug(
                    "No open issues with 'ci: disable-autorevert' label found. "
                    "Circuit breaker is inactive - autorevert will proceed normally."
                )
                return False

    except Exception as e:
        logger.error(f"Error checking autorevert circuit breaker: {e}")
        # On error, default to allowing autorevert to continue
        return False

import logging

from .github_client_helper import GHClientFactory
from .utils import RetryWithBackoff


logger = logging.getLogger(__name__)


def check_autorevert_disabled(repo_full_name: str = "pytorch/pytorch") -> bool:
    """
    Check if autorevert is disabled by looking for open issues with 'ci: disable-autorevert' label.

    Args:
        repo_full_name: Repository name in format 'owner/repo'

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
                disable_issues = repo.get_issues(
                    state="open", labels=["ci: disable-autorevert"]
                )

                for issue in disable_issues:
                    logger.info(
                        f"Found open issue #{issue.number} with 'ci: disable-autorevert' label "
                        f"created by user {issue.user.login}. "
                        f"Autorevert circuit breaker is ACTIVE."
                    )
                    should_disable = True

                sev_issues = repo.get_issues(state="open", labels=["ci: sev"])
                for issue in sev_issues:
                    logger.info(
                        f"Found open issue #{issue.number} with 'ci: sev' label "
                        f"created by user {issue.user.login}. "
                        f"Autorevert circuit breaker is ACTIVE."
                    )
                    should_disable = True

                if should_disable:
                    return True

                logger.debug(
                    "No open issues with 'ci: disable-autorevert' label found."
                )
                return False

    except Exception as e:
        logger.error(f"Error checking autorevert circuit breaker: {e}")
        # On error, default to allowing autorevert to continue
        return False

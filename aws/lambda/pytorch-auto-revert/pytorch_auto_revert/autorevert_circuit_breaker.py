import logging

from .github_client_helper import GHClientFactory
from .utils import RetryWithBackoff


logger = logging.getLogger(__name__)

# The label whose presence on an open issue disables autorevert.
DISABLE_AUTOREVERT_LABEL = "ci: disable-autorevert"

# Repository permission levels that authorize disabling autorevert. Adding a
# label to an issue requires triage/write access, but GitHub applies an issue
# template's labels on the author's behalf at creation time regardless of the
# author's permissions, so label presence alone is NOT proof of authority. We
# require the user who APPLIED the label to hold write access. "triage" is
# intentionally excluded: triagers may manage labels but should not be able to
# globally disable autorevert.
_AUTHORIZED_PERMISSIONS = frozenset({"admin", "write", "maintain"})


def _label_applier_login(issue, label_name: str):
    """Return the login of the user who most recently applied ``label_name`` to
    ``issue``, or ``None`` if it cannot be determined.

    The label *applier* — not the issue author — is the actor whose authority
    gates the killswitch. For a template-auto-applied label, GitHub records the
    "labeled" event with the issue author as the actor, so an unprivileged
    author who tripped the label via the template is correctly rejected here;
    while a maintainer who labels someone else's issue is correctly honored.
    """
    applier = None
    for ev in issue.get_events():
        if (
            ev.event == "labeled"
            and ev.label is not None
            and ev.label.name == label_name
        ):
            # get_events() is chronological; keep the latest applier so a
            # remove-then-re-add reflects whoever re-applied the label.
            applier = ev.actor.login if ev.actor is not None else None
    return applier


def check_autorevert_disabled(repo_full_name: str = "pytorch/pytorch") -> bool:
    """
    Check if autorevert is disabled by looking for open issues with the
    'ci: disable-autorevert' label that was applied by a user with write access.

    The label alone is not sufficient authority: a user without write
    permissions can still get the label onto an issue (e.g. via the issue
    template, whose labels GitHub applies on the author's behalf at creation
    time). To prevent an unprivileged user from disabling autorevert for the
    whole repo, we additionally require the user who applied the label to have
    write/maintain/admin permission on the repository.

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

                # Search for open issues with the specific label
                disable_issues = repo.get_issues(
                    state="open", labels=[DISABLE_AUTOREVERT_LABEL]
                )

                for issue in disable_issues:
                    try:
                        applier = _label_applier_login(issue, DISABLE_AUTOREVERT_LABEL)
                        permission = (
                            repo.get_collaborator_permission(applier)
                            if applier is not None
                            else None
                        )
                    except Exception as e:
                        # Fail safe: if we cannot positively confirm the label
                        # was applied by a write-access user, do NOT disable
                        # autorevert. Skip this issue, keep evaluating the rest.
                        logger.warning(
                            f"Could not resolve the '{DISABLE_AUTOREVERT_LABEL}' "
                            f"applier permission on issue #{issue.number}: {e}. "
                            f"Ignoring this issue for the autorevert circuit breaker."
                        )
                        continue

                    if applier is None:
                        logger.warning(
                            f"Could not determine who applied "
                            f"'{DISABLE_AUTOREVERT_LABEL}' to issue #{issue.number}; "
                            f"ignoring it for the autorevert circuit breaker."
                        )
                        continue

                    if permission not in _AUTHORIZED_PERMISSIONS:
                        logger.warning(
                            f"Ignoring open issue #{issue.number}: "
                            f"'{DISABLE_AUTOREVERT_LABEL}' was applied by {applier} "
                            f"with '{permission}' permission (write access required "
                            f"to disable autorevert)."
                        )
                        continue

                    logger.info(
                        f"Found open issue #{issue.number} with "
                        f"'{DISABLE_AUTOREVERT_LABEL}' applied by {applier} "
                        f"('{permission}' permission). "
                        f"Autorevert circuit breaker is ACTIVE."
                    )
                    return True

                logger.debug(
                    f"No open issues with '{DISABLE_AUTOREVERT_LABEL}' applied by a "
                    f"write-access user found."
                )
                return False

    except Exception as e:
        logger.error(f"Error checking autorevert circuit breaker: {e}")
        # On error, default to allowing autorevert to continue
        return False

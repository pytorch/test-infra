import dataclasses


@dataclasses.dataclass
class Repository:
    """Represents a repository in GitHub."""

    # Which organization owns this pull request.
    organization: str
    # The name of the repository, unique only within an organization.
    name: str

    def __str__(self, /) -> str:
        """Formats the repository with under its organization's namespace."""
        return f'{self.organization}/{self.name}'

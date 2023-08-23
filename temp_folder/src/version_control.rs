use crate::{git, path, sapling};

use anyhow;

pub struct Repo(RepoImpl);

enum RepoImpl {
    Git(git::Repo),
    Sapling(sapling::Repo),
}

// Trait describing the operations we need in lintrunner for a version
// control system.
pub trait System {
    // Creates a new instance, trying the different implementations we
    // have available.
    fn new() -> anyhow::Result<Self>
    where
        Self: Sized;

    // Gets the tip of the repository.
    fn get_head(&self) -> anyhow::Result<String>;

    // Gets the most recent common ancestor between the tip and the
    // given commit.
    fn get_merge_base_with(&self, merge_base_with: &str) -> anyhow::Result<String>;

    // Gets the files that have changed relative to the given commit.
    fn get_changed_files(&self, relative_to: Option<&str>) -> anyhow::Result<Vec<path::AbsPath>>;
}

impl Repo {
    pub fn new() -> anyhow::Result<Self> {
        git::Repo::new()
            .and_then(|repo| Ok(Repo(RepoImpl::Git(repo))))
            .or_else(|_| sapling::Repo::new().and_then(|repo| Ok(Repo(RepoImpl::Sapling(repo)))))
    }

    pub fn get_head(&self) -> anyhow::Result<String> {
        self.get_system().get_head()
    }

    pub fn get_merge_base_with(&self, merge_base_with: &str) -> anyhow::Result<String> {
        self.get_system().get_merge_base_with(merge_base_with)
    }

    pub fn get_changed_files(
        &self,
        relative_to: Option<&str>,
    ) -> anyhow::Result<Vec<path::AbsPath>> {
        self.get_system().get_changed_files(relative_to)
    }

    fn get_system<'a>(&'a self) -> Box<&'a dyn System> {
        match &self.0 {
            RepoImpl::Git(git) => Box::new(git as &dyn System),
            RepoImpl::Sapling(sapling) => Box::new(sapling as &dyn System),
        }
    }
}

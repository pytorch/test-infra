use std::{fs::OpenOptions, io::Write, process::Command};

use crate::version_control;

use anyhow::Result;
use tempfile::TempDir;

pub struct GitCheckout {
    root: TempDir,
}

impl GitCheckout {
    pub fn new() -> Result<GitCheckout> {
        let git = GitCheckout {
            root: TempDir::new()?,
        };

        assert_eq!(git.run("init").status()?.code(), Some(0));

        // We add an initial commit because git diff-tree behaves
        // differently when HEAD is the only commit in the
        // repository. In actual production uses, our git
        // diff-tree invocation will show the files modified in
        // the HEAD commit compared to HEAD~, but if HEAD~ doesn't
        // exist, it returns an empty list of files.
        git.write_file("README", "or don't")?;
        git.add("README")?;
        git.commit("initial commit")?;

        Ok(git)
    }

    // Gets the root directory of the git clone.
    pub fn root(&self) -> &std::path::Path {
        self.root.path()
    }

    pub fn rm_file(&self, name: &str) -> Result<()> {
        let path = self.root().join(name);
        std::fs::remove_file(path)?;
        Ok(())
    }

    pub fn write_file(&self, name: &str, contents: &str) -> Result<()> {
        let path = self.root().join(name);
        let mut file = OpenOptions::new()
            .read(true)
            .append(true)
            .create(true)
            .open(path)?;

        writeln!(file, "{}", contents)?;
        Ok(())
    }

    pub fn checkout_new_branch(&self, branch_name: &str) -> Result<()> {
        let output = Command::new("git")
            .args(&["checkout", "-b", branch_name])
            .current_dir(self.root())
            .output()?;
        assert!(output.status.success());
        Ok(())
    }

    pub fn add(&self, pathspec: &str) -> Result<()> {
        let output = Command::new("git")
            .args(&["add", pathspec])
            .current_dir(self.root())
            .output()?;
        assert!(output.status.success());
        Ok(())
    }

    pub fn commit(&self, message: &str) -> Result<()> {
        let output = Command::new("git")
            .args(&["commit", "-m", message])
            .current_dir(self.root())
            .output()?;
        assert!(output.status.success());
        Ok(())
    }

    pub fn changed_files(&self, relative_to: Option<&str>) -> Result<Vec<String>> {
        std::env::set_current_dir(self.root())?;
        let repo = version_control::Repo::new()?;
        let files = repo.get_changed_files(relative_to)?;
        let files = files
            .into_iter()
            .map(|abs_path| abs_path.file_name().unwrap().to_string_lossy().to_string())
            .collect::<Vec<_>>();
        Ok(files)
    }

    pub fn merge_base_with(&self, merge_base_with: &str) -> Result<String> {
        std::env::set_current_dir(self.root())?;
        let repo = version_control::Repo::new()?;
        repo.get_merge_base_with(merge_base_with)
    }

    // Returns a Command to run the subcommand in the clone.
    pub fn run(&self, subcommand: &str) -> std::process::Command {
        let mut cmd = std::process::Command::new("git");
        cmd.arg(subcommand);
        cmd.current_dir(self.root());
        cmd
    }
}

use crate::{log_utils, path, version_control};

use anyhow;

pub struct Repo {
    root: path::AbsPath,
}

impl version_control::System for Repo {
    fn new() -> anyhow::Result<Self> {
        let output = std::process::Command::new("sl").arg("root").output()?;
        anyhow::ensure!(output.status.success(), "Failed to determine Sapling root");
        let root = std::str::from_utf8(&output.stdout)?.trim();
        Ok(Repo {
            root: path::AbsPath::try_from(root)?,
        })
    }

    fn get_head(&self) -> anyhow::Result<String> {
        let mut cmd = std::process::Command::new("sl");
        cmd.arg("whereami");
        let output = cmd.current_dir(&self.root).output()?;
        log_utils::ensure_output(&format!("{:?}", cmd), &output)?;
        let head = std::str::from_utf8(&output.stdout)?.trim();
        Ok(head.to_string())
    }

    fn get_merge_base_with(&self, merge_base_with: &str) -> anyhow::Result<String> {
        let output = std::process::Command::new("sl")
            .arg("log")
            .arg(format!("--rev=ancestor(., {})", merge_base_with))
            .arg("--template={node}")
            .current_dir(&self.root)
            .output()?;

        anyhow::ensure!(
            output.status.success(),
            format!("Failed to get most recent common ancestor between . and {merge_base_with}")
        );
        let merge_base = std::str::from_utf8(&output.stdout)?.trim();
        Ok(merge_base.to_string())
    }

    fn get_changed_files(&self, relative_to: Option<&str>) -> anyhow::Result<Vec<path::AbsPath>> {
        // Output of sl status looks like:
        // D    src/lib.rs
        // M    foo/bar.baz
        let re = regex::Regex::new(r"^[A-Z?]\s+")?;

        // Retrieve changed files in current commit.
        let mut cmd = std::process::Command::new("sl");
        cmd.arg("status");
        cmd.arg(format!("--rev={}", relative_to.unwrap_or(".^")));
        cmd.current_dir(&self.root);
        let output = cmd.output()?;
        log_utils::ensure_output(&format!("{:?}", cmd), &output)?;

        let commit_files_str = std::str::from_utf8(&output.stdout)?;

        let commit_files: std::collections::HashSet<String> = commit_files_str
            .split('\n')
            .map(|x| x.to_string())
            // Filter out deleted files.
            .filter(|line| !line.starts_with('R'))
            .filter(|line| !line.starts_with('!'))
            // Strip the status prefix.
            .map(|line| re.replace(&line, "").to_string())
            .filter(|line| !line.is_empty())
            .collect();

        log_utils::log_files("Linting commit diff files: ", &commit_files);

        let filtered_commit_files = commit_files
            .into_iter()
            .map(|f| format!("{}", self.root.join(f).display()))
            .filter_map(|f| match path::AbsPath::try_from(&f) {
                Ok(abs_path) => Some(abs_path),
                Err(_) => {
                    eprintln!("Failed to find file while gathering files to lint: {}", f);
                    None
                }
            })
            .collect::<Vec<path::AbsPath>>();

        Ok(filtered_commit_files)
    }
}

#[cfg(test)]
mod tests {
    use std::{fs::OpenOptions, io::Write};

    use crate::testing;

    use super::*;
    use anyhow::Result;
    use tempfile::TempDir;

    struct SaplingClone {
        _temp_dir: TempDir,
        root: std::path::PathBuf,
    }

    impl SaplingClone {
        fn new(git_repo: &testing::GitCheckout) -> Result<SaplingClone> {
            let temp_dir = TempDir::new()?;
            assert_eq!(
                std::process::Command::new("sl")
                    .arg("clone")
                    .arg("--git")
                    .arg(git_repo.root())
                    .current_dir(temp_dir.path())
                    .status()?
                    .code(),
                Some(0)
            );
            let root = temp_dir.path().join(git_repo.root().file_name().unwrap());
            let sl = SaplingClone {
                _temp_dir: temp_dir,
                root,
            };
            Ok(sl)
        }

        fn run(&self, subcommand: &str) -> std::process::Command {
            let mut cmd = std::process::Command::new("sl");
            cmd.current_dir(&self.root);
            cmd.arg(subcommand);
            cmd
        }

        fn rm_file(&self, name: &str) -> Result<()> {
            let path = self.root.join(name);
            std::fs::remove_file(path)?;
            Ok(())
        }

        fn write_file(&self, name: &str, contents: &str) -> Result<()> {
            let path = self.root.join(name);
            let mut file = OpenOptions::new()
                .read(true)
                .append(true)
                .create(true)
                .open(path)?;

            writeln!(file, "{}", contents)?;
            Ok(())
        }

        fn add(&self, pathspec: &str) -> Result<()> {
            assert_eq!(self.run("add").arg(pathspec).status()?.code(), Some(0));
            Ok(())
        }

        fn rm(&self, pathspec: &str) -> Result<()> {
            assert_eq!(self.run("rm").arg(pathspec).status()?.code(), Some(0));
            Ok(())
        }

        fn commit(&self, message: &str) -> Result<()> {
            assert_eq!(
                self.run("commit")
                    .arg(format!("--message={}", message))
                    .status()?
                    .code(),
                Some(0)
            );
            Ok(())
        }

        fn changed_files(&self, relative_to: Option<&str>) -> Result<Vec<String>> {
            std::env::set_current_dir(&self.root)?;
            use version_control::System;
            let repo = Repo::new()?;
            let files = repo.get_changed_files(relative_to)?;
            let files = files
                .into_iter()
                .map(|abs_path| abs_path.file_name().unwrap().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            Ok(files)
        }

        fn merge_base_with(&self, merge_base_with: &str) -> Result<String> {
            std::env::set_current_dir(&self.root)?;
            use version_control::System;
            let repo = Repo::new()?;
            repo.get_merge_base_with(merge_base_with)
        }
    }

    // Should properly detect changes in the commit (and not check other files)
    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn doesnt_detect_unchanged() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        // Don't write anthing to file 2 for this!
        git.write_file("test_1.txt", "commit 2")?;

        git.add(".")?;
        git.commit("commit 2")?;

        let sl = SaplingClone::new(&git)?;

        // Add some uncomitted changes to the working tree
        sl.write_file("test_3.txt", "commit 2")?;

        let files = sl.changed_files(None)?;
        assert_eq!(files.len(), 2);
        assert!(files.contains(&"test_1.txt".to_string()));
        assert!(files.contains(&"test_3.txt".to_string()));
        Ok(())
    }

    // Files that were deleted in the commit should not be checked, since
    // obviously they are gone.
    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn deleted_files_in_commit() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        let sl = SaplingClone::new(&git)?;

        sl.rm_file("test_1.txt")?;

        let files = sl.changed_files(None)?; // still looks at the parent commit
        assert_eq!(files.len(), 2);

        sl.rm("test_1.txt")?;

        sl.commit("removal commit")?;

        // Remove a file in the working tree as well.
        sl.rm("test_2.txt")?;

        let files = sl.changed_files(None)?;
        assert_eq!(files.len(), 0);
        Ok(())
    }

    // Files that were deleted/moved in the working tree should not be checked,
    // since obviously they are gone.
    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn moved_files_working_tree() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.add(".")?;
        git.commit("commit 1")?;

        git.write_file("test_2.txt", "foo")?;
        git.add(".")?;
        git.commit("commit 2")?;

        let sl = SaplingClone::new(&git)?;

        assert_eq!(
            sl.run("move")
                .arg("test_2.txt")
                .arg("new.txt")
                .status()?
                .code(),
            Some(0)
        );

        let files = sl.changed_files(None)?;
        assert!(files.contains(&"new.txt".to_string()));
        Ok(())
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn relative_revision() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("I am HEAD~2")?;

        git.write_file("test_1.txt", "foo")?;

        git.add(".")?;
        git.commit("I am HEAD~1")?;

        git.write_file("test_2.txt", "foo")?;

        git.add(".")?;
        git.commit("I am HEAD")?;

        let sl = SaplingClone::new(&git)?;

        // Add some uncomitted changes to the working tree
        sl.write_file("test_3.txt", "commit 2")?;

        {
            // Relative to the HEAD commit, only the working tree changes should
            // be checked.
            let files = sl.changed_files(Some("."))?;
            assert_eq!(files.len(), 1);
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let files = sl.changed_files(Some(".^"))?;
            assert_eq!(files.len(), 2);
            assert!(files.contains(&"test_2.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let files = sl.changed_files(Some(".^^"))?;
            assert_eq!(files.len(), 3);
            assert!(files.contains(&"test_1.txt".to_string()));
            assert!(files.contains(&"test_2.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        Ok(())
    }

    // File deletions should work correctly even if a relative revision is
    // specified.
    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn deleted_files_relative_revision() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        let sl = SaplingClone::new(&git)?;

        sl.rm_file("test_1.txt")?;

        let files = sl.changed_files(None)?;
        assert_eq!(files.len(), 2);

        sl.rm("test_1.txt")?;
        sl.commit("removal commit")?;

        sl.write_file("test_2.txt", "Initial commit")?;
        sl.add(".")?;
        sl.commit("another commit")?;

        assert_eq!(sl.run("sl").status()?.code(), Some(0));

        let files = sl.changed_files(Some(".^^"))?;
        assert_eq!(files.len(), 1);
        Ok(())
    }

    #[test]
    #[cfg_attr(target_os = "windows", ignore)] // remove when sapling installation is better
    #[cfg_attr(target_os = "linux", ignore)] // remove when sapling installation is better
    fn merge_base_with() -> Result<()> {
        let git = testing::GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;
        git.write_file("test_4.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("I am main")?;

        git.checkout_new_branch("branch1")?;
        git.write_file("test_1.txt", "foo")?;
        git.add(".")?;
        git.commit("I am on branch1")?;

        git.checkout_new_branch("branch2")?;
        git.write_file("test_2.txt", "foo")?;
        git.add(".")?;
        git.commit("I am branch2")?;

        git.checkout_new_branch("branch3")?;
        git.write_file("test_3.txt", "blah")?;
        git.add(".")?;
        git.commit("I am branch3")?;

        let sl = SaplingClone::new(&git)?;

        // Add some uncomitted changes to the working tree
        sl.write_file("test_4.txt", "blahblah")?;

        assert_eq!(
            sl.run("pull")
                .arg("--bookmark=branch1")
                .arg("--bookmark=branch2")
                .status()?
                .code(),
            Some(0)
        );

        {
            let merge_base = Some(sl.merge_base_with("branch2")?);
            let files = sl.changed_files(merge_base.as_deref())?;
            assert_eq!(files.len(), 2);
            assert!(files.contains(&"test_4.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let merge_base = Some(sl.merge_base_with("branch1")?);
            let files = sl.changed_files(merge_base.as_deref())?;
            assert_eq!(files.len(), 3);
            assert!(files.contains(&"test_4.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
            assert!(files.contains(&"test_2.txt".to_string()));
        }
        Ok(())
    }
}

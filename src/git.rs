use std::{collections::HashSet, convert::TryFrom, process::Command};

use crate::{
    log_utils::{ensure_output, log_files},
    path::AbsPath,
};
use anyhow::{ensure, Context, Result};
use log::debug;
use regex::Regex;

pub fn get_paths_from_cmd(paths_cmd: String) -> Result<Vec<AbsPath>> {
    debug!("Running paths_cmd: {}", paths_cmd);
    let output = Command::new("sh")
        .arg("-c")
        .arg(paths_cmd)
        .output()
        .context("failed to run provided paths_cmd")?;

    let files = std::str::from_utf8(&output.stdout).context("failed to parse paths_cmd output")?;
    let files = files
        .lines()
        .map(|s| s.to_string())
        .collect::<HashSet<String>>();
    let mut files = files.into_iter().collect::<Vec<String>>();
    files.sort();
    files
        .into_iter()
        .map(AbsPath::try_from)
        .collect::<Result<_>>()
}

pub fn get_merge_base_with(git_root: &AbsPath, merge_base_with: &str) -> Result<String> {
    let output = Command::new("git")
        .arg("merge-base")
        .arg("HEAD")
        .arg(merge_base_with)
        .current_dir(git_root)
        .output()?;

    ensure!(
        output.status.success(),
        format!("Failed to get merge-base between HEAD and {merge_base_with}")
    );
    let merge_base = std::str::from_utf8(&output.stdout)?.trim();
    Ok(merge_base.to_string())
}

pub fn get_changed_files(git_root: &AbsPath, relative_to: Option<&str>) -> Result<Vec<AbsPath>> {
    // Output of --name-status looks like:
    // D    src/lib.rs
    // M    foo/bar.baz
    let re = Regex::new(r"^[A-Z]\s+")?;

    // Retrieve changed files in current commit.
    let mut args = vec![
        "diff-tree",
        "--ignore-submodules",
        "--no-commit-id",
        "--name-status",
        "-r",
    ];
    if let Some(relative_to) = relative_to {
        args.push(relative_to);
    }
    args.push("HEAD");

    let output = Command::new("git")
        .args(&args)
        .current_dir(git_root)
        .output()?;
    ensure_output("git diff-tree", &output)?;

    let commit_files_str = std::str::from_utf8(&output.stdout)?;

    let commit_files: HashSet<String> = commit_files_str
        .split('\n')
        .map(|x| x.to_string())
        // Filter out deleted files.
        .filter(|line| !line.starts_with('D'))
        // Strip the status prefix.
        .map(|line| re.replace(&line, "").to_string())
        .filter(|line| !line.is_empty())
        .collect();

    log_files("Linting commit diff files: ", &commit_files);

    // Retrieve changed files in the working tree
    let output = Command::new("git")
        .arg("diff-index")
        .arg("--ignore-submodules")
        .arg("--no-commit-id")
        .arg("--name-status")
        .arg("-r")
        .arg("HEAD")
        .current_dir(git_root)
        .output()?;
    ensure_output("git diff-index", &output)?;

    let working_tree_files_str = std::str::from_utf8(&output.stdout)?;
    let working_tree_files: HashSet<String> = working_tree_files_str
        .lines()
        .filter(|line| !line.is_empty())
        // Filter out deleted files.
        .filter(|line| !line.starts_with('D'))
        // Strip the status prefix.
        .map(|line| re.replace(line, "").to_string())
        .collect();

    log_files("Linting working tree diff files: ", &working_tree_files);

    working_tree_files
        .union(&commit_files)
        .into_iter()
        // Git reports files relative to the root of git root directory, so retrieve
        // that and prepend it to the file paths.
        .map(|f| format!("{}/{}", git_root.display(), f))
        .map(|f| {
            AbsPath::try_from(&f).with_context(|| {
                format!("Failed to find file while gathering files to lint: {}", f)
            })
        })
        .collect::<Result<_>>()
}

// Retrieve the git root based on the current working directory.
pub fn get_git_root() -> Result<AbsPath> {
    let output = Command::new("git")
        .arg("rev-parse")
        .arg("--show-toplevel")
        .output()?;
    ensure!(output.status.success(), "Failed to determine git root");
    let root = std::str::from_utf8(&output.stdout)?.trim();
    AbsPath::try_from(root)
}

#[cfg(test)]
mod tests {
    use std::{convert::TryFrom, fs::OpenOptions, io::Write};

    use super::*;
    use tempfile::TempDir;

    struct GitCheckout {
        root: TempDir,
    }

    impl GitCheckout {
        fn new() -> Result<GitCheckout> {
            let root = TempDir::new()?;

            Command::new("git")
                .args(&["init"])
                .current_dir(root.path())
                .output()?;

            Ok(GitCheckout { root })
        }

        fn rm_file(&self, name: &str) -> Result<()> {
            let path = self.root.path().join(name);
            std::fs::remove_file(path)?;
            Ok(())
        }

        fn write_file(&self, name: &str, contents: &str) -> Result<()> {
            let path = self.root.path().join(name);
            let mut file = OpenOptions::new()
                .read(true)
                .append(true)
                .create(true)
                .open(path)?;

            writeln!(file, "{}", contents)?;
            Ok(())
        }

        fn checkout_new_branch(&self, branch_name: &str) -> Result<()> {
            let output = Command::new("git")
                .args(&["checkout", "-b", branch_name])
                .current_dir(self.root.path())
                .output()?;
            assert!(output.status.success());
            Ok(())
        }

        fn add(&self, pathspec: &str) -> Result<()> {
            let output = Command::new("git")
                .args(&["add", pathspec])
                .current_dir(self.root.path())
                .output()?;
            assert!(output.status.success());
            Ok(())
        }

        fn commit(&self, message: &str) -> Result<()> {
            let output = Command::new("git")
                .args(&["commit", "-m", message])
                .current_dir(self.root.path())
                .output()?;
            assert!(output.status.success());
            Ok(())
        }

        fn changed_files(&self, relative_to: Option<&str>) -> Result<Vec<String>> {
            let git_root = AbsPath::try_from(self.root.path())?;
            let files = get_changed_files(&git_root, relative_to)?;
            let files = files
                .into_iter()
                .map(|abs_path| abs_path.file_name().unwrap().to_string_lossy().to_string())
                .collect::<Vec<_>>();
            Ok(files)
        }

        fn merge_base_with(&self, merge_base_with: &str) -> Result<String> {
            let git_root = AbsPath::try_from(self.root.path())?;
            get_merge_base_with(&git_root, merge_base_with)
        }
    }

    // Should properly detect changes in the commit (and not check other files)
    #[test]
    fn doesnt_detect_unchanged() -> Result<()> {
        let git = GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        // Don't write anthing to file 2 for this!
        git.write_file("test_1.txt", "commit 2")?;

        git.add(".")?;
        git.commit("commit 2")?;

        // Add some uncomitted changes to the working tree
        git.write_file("test_3.txt", "commit 2")?;

        let files = git.changed_files(None)?;
        assert_eq!(files.len(), 2);
        assert!(files.contains(&"test_1.txt".to_string()));
        assert!(files.contains(&"test_3.txt".to_string()));
        Ok(())
    }

    // Files that were deleted in the commit should not be checked, since
    // obviously they are gone.
    #[test]
    fn deleted_files_in_commit() -> Result<()> {
        let git = GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        git.rm_file("test_1.txt")?;

        let files = git.changed_files(None)?;
        assert_eq!(files.len(), 0);

        git.add(".")?;
        git.commit("removal commit")?;

        // Remove a file in the working tree as well.
        git.rm_file("test_2.txt")?;

        let files = git.changed_files(None)?;
        assert_eq!(files.len(), 0);
        Ok(())
    }

    #[test]
    fn relative_revision() -> Result<()> {
        let git = GitCheckout::new()?;
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

        // Add some uncomitted changes to the working tree
        git.write_file("test_3.txt", "commit 2")?;

        {
            // Relative to the HEAD commit, only the working tree changes should
            // be checked.
            let files = git.changed_files(Some("HEAD"))?;
            assert_eq!(files.len(), 1);
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let files = git.changed_files(Some("HEAD~1"))?;
            assert_eq!(files.len(), 2);
            assert!(files.contains(&"test_2.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let files = git.changed_files(Some("HEAD~2"))?;
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
    fn deleted_files_relative_revision() -> Result<()> {
        let git = GitCheckout::new()?;
        git.write_file("test_1.txt", "Initial commit")?;
        git.write_file("test_2.txt", "Initial commit")?;
        git.write_file("test_3.txt", "Initial commit")?;

        git.add(".")?;
        git.commit("commit 1")?;

        git.rm_file("test_1.txt")?;

        let files = git.changed_files(None)?;
        assert_eq!(files.len(), 0);

        git.add(".")?;
        git.commit("removal commit")?;

        git.write_file("test_2.txt", "Initial commit")?;
        git.add(".")?;
        git.commit("another commit")?;

        let files = git.changed_files(Some("HEAD~2"))?;
        assert_eq!(files.len(), 1);
        Ok(())
    }

    #[test]
    fn merge_base_with() -> Result<()> {
        let git = GitCheckout::new()?;
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

        // Add some uncomitted changes to the working tree
        git.write_file("test_4.txt", "blahblah")?;

        {
            let merge_base = Some(git.merge_base_with("branch2")?);
            let files = git.changed_files(merge_base.as_deref())?;
            assert_eq!(files.len(), 2);
            assert!(files.contains(&"test_4.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
        }
        {
            let merge_base = Some(git.merge_base_with("branch1")?);
            let files = git.changed_files(merge_base.as_deref())?;
            assert_eq!(files.len(), 3);
            assert!(files.contains(&"test_4.txt".to_string()));
            assert!(files.contains(&"test_3.txt".to_string()));
            assert!(files.contains(&"test_2.txt".to_string()));
        }
        Ok(())
    }
}

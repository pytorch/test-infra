use std::{collections::HashSet, path::PathBuf, process::Command};

use crate::path::AbsPath;
use anyhow::{ensure, Context, Result};
use log::debug;
use regex::Regex;

pub fn get_paths_cmd_files(paths_cmd: String) -> Result<Vec<AbsPath>> {
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
        .map(|f| AbsPath::new(PathBuf::from(f)))
        .collect::<Result<_>>()
}

pub fn get_changed_files(git_root: AbsPath) -> Result<Vec<AbsPath>> {
    let git_root = git_root.as_pathbuf().as_path();
    // Output of --name-status looks like:
    // D    src/lib.rs
    // M    foo/bar.baz
    let re = Regex::new(r"^[A-Z]\s+")?;

    // Retrieve changed files in current commit.
    let output = Command::new("git")
        .arg("diff-tree")
        .arg("--no-commit-id")
        .arg("--name-status")
        .arg("-r")
        .arg("HEAD")
        .current_dir(git_root)
        .output()?;
    ensure!(
        output.status.success(),
        "Failed to determine files to lint; git diff-tree failed"
    );

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

    if commit_files.len() < 10 {
        debug!("Linting commit diff files: {:?}", commit_files);
    }

    // Retrieve changed files in the working tree
    let output = Command::new("git")
        .arg("diff-index")
        .arg("--no-commit-id")
        .arg("--name-status")
        .arg("-r")
        .arg("HEAD")
        .current_dir(git_root)
        .output()?;
    ensure!(
        output.status.success(),
        "Failed to determine files to lint; git diff-index failed"
    );

    let working_tree_files_str = std::str::from_utf8(&output.stdout)?;
    let working_tree_files: HashSet<String> = working_tree_files_str
        .lines()
        .filter(|line| !line.is_empty())
        // Filter out deleted files.
        .filter(|line| !line.starts_with('D'))
        // Strip the status prefix.
        .map(|line| re.replace(line, "").to_string())
        .collect();

    if working_tree_files.len() < 10 {
        debug!("Linting working tree diff files: {:?}", working_tree_files);
    }

    let mut all_changed_files: Vec<&String> = working_tree_files.union(&commit_files).collect();

    // Sort for consistency
    all_changed_files.sort();

    // Git reports files relative to the root of git root directory, so retrieve
    // that and prepend it to the file paths.

    all_changed_files
        .into_iter()
        .map(|f| format!("{}/{}", git_root.display(), f))
        .map(|f| {
            AbsPath::new(PathBuf::from(&f)).with_context(|| {
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
    AbsPath::new(PathBuf::from(root))
}

#[cfg(test)]
mod tests {
    use std::{fs::OpenOptions, io::Write};

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

        fn changed_files(&self) -> Result<Vec<String>> {
            let git_root = AbsPath::new(PathBuf::from(self.root.path()))?;
            let files = get_changed_files(git_root)?;
            let files = files
                .into_iter()
                .map(|abs_path| {
                    abs_path
                        .as_pathbuf()
                        .file_name()
                        .unwrap()
                        .to_string_lossy()
                        .to_string()
                })
                .collect::<Vec<_>>();
            Ok(files)
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

        let files = git.changed_files()?;
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

        let files = git.changed_files()?;
        assert_eq!(files.len(), 0);

        git.add(".")?;
        git.commit("removal commit")?;

        // Remove a file in the working tree as well.
        git.rm_file("test_2.txt")?;

        let files = git.changed_files()?;
        assert_eq!(files.len(), 0);
        Ok(())
    }
}

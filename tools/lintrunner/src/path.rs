use anyhow::Result;
use std::{
    convert::TryFrom,
    fmt,
    ops::Deref,
    path::{Path, PathBuf},
};

/// Represents a canonicalized path to a file or directory.
#[derive(PartialOrd, Ord, Eq, PartialEq, Hash, Clone)]
pub struct AbsPath {
    inner: PathBuf,
}

impl fmt::Debug for AbsPath {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.inner.display())
    }
}

// Ideally we could could create a generic TryFrom implementation for anything
// that implements Into<PathBuf>, but apparently this is not possible?
// https://github.com/rust-lang/rust/issues/50133
impl TryFrom<PathBuf> for AbsPath {
    type Error = anyhow::Error;
    fn try_from(p: PathBuf) -> Result<Self> {
        Ok(AbsPath {
            inner: p.canonicalize()?,
        })
    }
}

impl TryFrom<&Path> for AbsPath {
    type Error = anyhow::Error;
    fn try_from(p: &Path) -> Result<Self> {
        Ok(AbsPath {
            inner: PathBuf::from(p).canonicalize()?,
        })
    }
}

impl TryFrom<&String> for AbsPath {
    type Error = anyhow::Error;
    fn try_from(p: &String) -> Result<Self> {
        Ok(AbsPath {
            inner: PathBuf::from(p).canonicalize()?,
        })
    }
}
impl TryFrom<String> for AbsPath {
    type Error = anyhow::Error;
    fn try_from(p: String) -> Result<Self> {
        Ok(AbsPath {
            inner: PathBuf::from(p).canonicalize()?,
        })
    }
}

impl TryFrom<&str> for AbsPath {
    type Error = anyhow::Error;
    fn try_from(p: &str) -> Result<Self> {
        Ok(AbsPath {
            inner: PathBuf::from(p).canonicalize()?,
        })
    }
}

impl Deref for AbsPath {
    type Target = Path;

    fn deref(&self) -> &Self::Target {
        self.inner.as_path()
    }
}

impl AsRef<Path> for AbsPath {
    fn as_ref(&self) -> &Path {
        self.inner.as_path()
    }
}

// This routine is adapted from the *old* Path's `path_relative_from`
// function, which works differently from the new `relative_from` function.
// In particular, this handles the case on unix where both paths are
// absolute but with only the root as the common directory.
// From: https://stackoverflow.com/questions/39340924/given-two-absolute-paths-how-can-i-express-one-of-the-paths-relative-to-the-oth
//
// path_relative_from(/foo/bar, /foo) -> bar
pub fn path_relative_from(path: &Path, base: &Path) -> Option<PathBuf> {
    use std::path::Component;

    if path.is_absolute() != base.is_absolute() {
        if path.is_absolute() {
            Some(PathBuf::from(path))
        } else {
            None
        }
    } else {
        let mut ita = path.components();
        let mut itb = base.components();
        let mut comps: Vec<Component> = vec![];
        loop {
            match (ita.next(), itb.next()) {
                (None, None) => break,
                (Some(a), None) => {
                    comps.push(a);
                    comps.extend(ita.by_ref());
                    break;
                }
                (None, _) => comps.push(Component::ParentDir),
                (Some(a), Some(b)) if comps.is_empty() && a == b => (),
                (Some(a), Some(b)) if b == Component::CurDir => comps.push(a),
                (Some(_), Some(b)) if b == Component::ParentDir => return None,
                (Some(a), Some(_)) => {
                    comps.push(Component::ParentDir);
                    for _ in itb {
                        comps.push(Component::ParentDir);
                    }
                    comps.push(a);
                    comps.extend(ita.by_ref());
                    break;
                }
            }
        }
        Some(comps.iter().map(|c| c.as_os_str()).collect())
    }
}

//
pub fn get_display_path(path: &str, current_dir: &Path) -> String {
    let abs_path = AbsPath::try_from(path);
    match abs_path {
        Ok(abs_path) => {
            // unwrap will never panic because we know `abs_path` is absolute.
            let relative_path = path_relative_from(&abs_path, current_dir).unwrap();

            relative_path.display().to_string()
        }
        // If we can't relativize for some reason, just return the path as
        // reported by the linter.
        Err(_) => path.to_string(),
    }
}

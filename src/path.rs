use anyhow::Result;
use std::path::{Path, PathBuf};

/// Represents a canonicalized path to a file or directory.
#[derive(Debug, PartialOrd, Ord, Eq, PartialEq, Hash, Clone)]
pub struct AbsPath {
    inner: PathBuf,
}

impl AbsPath {
    pub fn new(p: PathBuf) -> Result<AbsPath> {
        Ok(AbsPath {
            inner: p.canonicalize()?,
        })
    }

    pub fn as_pathbuf(&self) -> &PathBuf {
        &self.inner
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

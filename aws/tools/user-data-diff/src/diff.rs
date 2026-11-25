use colored::*;
use similar::{ChangeTag, TextDiff};

pub fn display_diff(old_text: &str, new_text: &str, use_color: bool) {
    if old_text == new_text {
        println!("No differences found.");
        return;
    }

    let diff = TextDiff::from_lines(old_text, new_text);

    for change in diff.iter_all_changes() {
        let (prefix, line_style) = match change.tag() {
            ChangeTag::Delete => ("- ", if use_color { "red" } else { "" }),
            ChangeTag::Insert => ("+ ", if use_color { "green" } else { "" }),
            ChangeTag::Equal => ("  ", ""),
        };

        let line = format!("{}{}", prefix, change);

        if use_color && !line_style.is_empty() {
            match line_style {
                "red" => print!("{}", line.red()),
                "green" => print!("{}", line.green()),
                _ => print!("{}", line),
            }
        } else {
            print!("{}", line);
        }
    }

    let stats = diff.ratio();
    println!();
    if use_color {
        println!("Similarity: {:.1}%", (stats * 100.0).to_string().cyan());
    } else {
        println!("Similarity: {:.1}%", stats * 100.0);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_display_diff_identical() {
        let text = "line1\nline2\nline3";
        display_diff(text, text, false);
    }

    #[test]
    fn test_display_diff_different() {
        let old_text = "line1\nline2\nline3";
        let new_text = "line1\nline2_modified\nline3\nline4";
        display_diff(old_text, new_text, false);
    }
}

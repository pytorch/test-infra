// use glob::Pattern;

// pub struct Linter {
//     patterns: Vec<Pattern>,
//     commands: Vec<String>,
// }

// impl Linter {
//     pub fn run(&self, matches: Vec<String>) -> Result<Vec<LintMessage>> {
//     if matches.is_empty() {
//         return Ok(Vec::new());
//     }
//     let file = write_matches_to_file(matches)?;
//     run_linter_command(&self.commands, file)
// }
// }

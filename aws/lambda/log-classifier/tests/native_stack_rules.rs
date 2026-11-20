//! Rules for the merge bot's GitHub-native stack errors (`native_stack.NativeStackError`
//! in pytorch's .github/scripts). These are unit cases rather than
//! `fixtures/classify/` files because fixtures must be verbatim CI logs, while each
//! message below copies the f-string of its raise site in native_stack.py /
//! trymerge.py with sample values.

use log_classifier::engine::evaluate_ruleset;
use log_classifier::log::Log;
use log_classifier::rule::RuleSet;

const REBASE_HINT: &str =
    "Rebase the stack onto main with `@pytorchbot rebase -b main` and try again.";

fn classify(log: &str) -> (String, Vec<String>, usize) {
    let ruleset = RuleSet::new_from_config();
    let m = evaluate_ruleset(&ruleset, &Log::new(log.to_string()))
        .unwrap_or_else(|| panic!("nothing classified:\n{log}"));
    (m.rule.name, m.captures, m.line_number)
}

fn assert_rule(message: &str, rule: &str, captures: &[&str]) {
    let line = format!("native_stack.NativeStackError: {message}");
    let (name, got, _) = classify(&line);
    assert_eq!(
        (name.as_str(), got),
        (rule, captures.iter().map(|c| c.to_string()).collect()),
        "{line}"
    );
}

#[test]
fn branch_needs_updating() {
    let rule = "Native stack branch needs updating";
    let cases: &[(String, &[&str])] = &[
        (
            format!("PR #102 is not based on the tip of user/merge-a. {REBASE_HINT}"),
            &["is not based on the tip of"],
        ),
        (
            format!("PR #102 contains main commits that user/a does not have. {REBASE_HINT}"),
            &["contains main commits that"],
        ),
        (
            format!(
                "PR #102 landed in 0123456789abcdef0123456789abcdef01234567, which its merge \
                 base with main still has, so its changes would not land again. {REBASE_HINT}"
            ),
            &["so its changes would not land again"],
        ),
        (
            format!("PR #102 has conflicts with the commits below it. {REBASE_HINT}"),
            &["has conflicts with the commits below it"],
        ),
        (
            format!(
                "viable/strict is behind main for PR #102: it still has the PR's landing \
                 0123456789abcdef0123456789abcdef01234567, which main reverted or replaced \
                 since. {REBASE_HINT}"
            ),
            &["is behind main for PR"],
        ),
        (
            "Merging main into user/b (PR #102) has conflicts; merge it locally and push the \
             result"
                .to_string(),
            &["has conflicts; merge it locally"],
        ),
        (
            "Reapplying PR #102 on its branch after its revert has conflicts; update the branch \
             locally, keeping the PR's changes, and push the result"
                .to_string(),
            &["on its branch after its revert has conflicts"],
        ),
    ];
    for (message, captures) in cases {
        assert_rule(message, rule, captures);
    }
}

#[test]
fn stack_refused() {
    let rule = "Native stack refused";
    let cases: &[(&str, &[&str])] = &[
        ("PR #102 is not in the stack", &["is not in the stack"]),
        ("PR #102 is not in a stack", &["is not in a stack"]),
        ("PR #102 is closed", &["is closed"]),
        (
            "PR #101 is a ghstack PR, and the bot does not support stacks that mix ghstack PRs \
             with other PRs; unstack the other PRs",
            &["is a ghstack PR"],
        ),
        (
            "PR #101 is at the bottom of the stack, so its base must be the stack's trunk \
             (main), not user/x",
            &["is at the bottom of the stack"],
        ),
        (
            "PR #102 targets user/x instead of user/a, the branch of PR #101 below it in the \
             stack",
            &["targets", "instead of"],
        ),
        (
            "PR #102 is closed, but PR #101 below it is still open",
            &["is closed, but", "below it is still open"],
        ),
        (
            "PR #101 is closed, but its branch has commits that never landed on main: \
             0123456789abcdef0123456789abcdef01234567",
            &["is closed, but its branch has commits that never landed"],
        ),
        (
            "PR #101 is closed but not landed on main, or it was reverted; reopen it and try \
             again",
            &["is closed but not landed"],
        ),
        (
            "PR #101 already landed but is still open; try again once it is closed",
            &["already landed but is still open"],
        ),
        (
            "PR #102 is in a stack based on viable/strict, but only stacks based on main can be \
             merged",
            &["but only stacks based on main can be merged"],
        ),
        (
            "PR #102 is in a stack based on viable/strict, but only stacks based on main can be \
             rebased",
            &["but only stacks based on main can be rebased"],
        ),
        (
            "PR #102 has no changes to land: it is empty, or its changes already landed",
            &["has no changes to land"],
        ),
        (
            "PR #101 is opened from main, so rebasing it would push to main",
            &["is opened from", "so rebasing it would push to"],
        ),
        (
            "The head of PR #102 is already in viable/strict, so it has nothing to rebase; close \
             the PR if it landed",
            &["is already in", "so it has nothing to rebase"],
        ),
    ];
    for (message, captures) in cases {
        assert_rule(message, rule, captures);
    }
}

#[test]
fn read_failed_or_changed() {
    let rule = "Native stack read failed or changed";
    let cases: &[(&str, &[&str])] = &[
        (
            "GraphQL errors: Timeout; Something went wrong",
            &["GraphQL errors"],
        ),
        (
            "Could not read all 12 PRs in the stack of PR #102",
            &["Could not read all", "PRs in the stack"],
        ),
        (
            "Could not fetch main and the commits of PRs #101, #102: Command `git -C /w fetch \
             origin` returned non-zero exit code 128",
            &["Could not fetch"],
        ),
        (
            "Could not fetch main, viable/strict, user/a and the open PRs of the stack: boom",
            &["Could not fetch"],
        ),
        (
            "PR #101 was updated while preparing the merge, please try again",
            &["was updated while preparing the merge"],
        ),
    ];
    for (message, captures) in cases {
        assert_rule(message, rule, captures);
    }
}

#[test]
fn unknown_message_hits_catch_all() {
    assert_rule(
        "PR #102 hit a refusal no rule knows about",
        "Native stack error (other)",
        &["native_stack.NativeStackError"],
    );
}

// The chained cause is a git-command RuntimeError whose branch name contains
// "merge", which the ghstack git-command rule matches: the native-stack line must
// still win.
#[test]
fn chained_traceback_lands_on_native_stack_error() {
    let log = "\
Traceback (most recent call last):
  File \"/w/.github/scripts/native_stack.py\", line 380, in get_native_stack_landing_prs
    repo._run_git(\"fetch\", repo.remote, *refspecs)
RuntimeError: Command `git -C /w fetch origin +refs/heads/user/merge-fix:refs/remotes/origin/user/merge-fix` returned non-zero exit code 128

The above exception was the direct cause of the following exception:

Traceback (most recent call last):
  File \"/w/.github/scripts/trymerge.py\", line 4180, in main
    merge(
native_stack.NativeStackError: Could not fetch main and the commits of PRs #101, #102: Command `git -C /w fetch origin +refs/heads/user/merge-fix:refs/remotes/origin/user/merge-fix` returned non-zero exit code 128
";
    let (name, captures, line) = classify(log);
    assert_eq!(name, "Native stack read failed or changed");
    assert_eq!(captures, vec!["Could not fetch"]);
    assert_eq!(line, 11);
}

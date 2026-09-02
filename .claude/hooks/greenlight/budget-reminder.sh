#!/bin/bash
# PostToolUse hook: rate-limited nudge telling the reviewer how much of its review
# time budget is left.
#
# The reviewer runs with --allowedTools Read,Glob,Grep,Write -- no Bash, so it has
# no clock and cannot poll one. This push channel is the only way it can perceive
# elapsed time, which is why the whole budget mechanism lives here and the skill
# only describes how to react to it.
#
# Advisory only. PostToolUse cannot block a tool call, and every path here ends at
# an explicit exit 0: the digit guards and the 10# normalisation below leave no
# expansion that can fail, which is the only way `set -u` could abort ahead of one.
# A fault here can therefore never change a verdict. The model sees only the
# structured hookSpecificOutput.additionalContext; plain stdout is not surfaced for
# PostToolUse, so silence == no reminder.
#
# Every nudge is phrased as an observation, never as an order. Text that reads as an
# out-of-band system command trips the model's prompt-injection defences, which
# surfaces it to the operator as suspicious input instead of folding it into context.
#
# `set -e` is omitted so no incidental non-zero command can abort the script ahead
# of its explicit exit 0. `set -u` is kept for the opposite reason: a mistyped
# variable should abort loudly rather than degrade into a nudge that is silently
# dead for every run.
set -uo pipefail

# Claude Code writes the tool-call event JSON to hook stdin without waiting for a
# reader (CLI 2.1.169, the version the workflow pins). Nothing here needs the payload,
# but leaving it unread makes that write fail with EPIPE as soon as it outgrows the
# pipe buffer, so drain it first. Skipped on a terminal, where there is no writer to
# reach EOF and cat would hang.
if [[ ! -t 0 ]]; then
  cat >/dev/null 2>&1 || true
fi

# jq is probed before any state is touched so a jq-less environment never advances
# the rate-limit clock -- bumping the state file without emitting would swallow the
# next reminder as well. A jq that is present but fails is handled at the emit.
command -v jq >/dev/null 2>&1 || exit 0

now=$(date +%s 2>/dev/null) || exit 0
start_epoch="${GREENLIGHT_REVIEW_START_EPOCH:-}"
target_deadline="${GREENLIGHT_REVIEW_TARGET_DEADLINE:-}"
soft_deadline="${GREENLIGHT_REVIEW_SOFT_DEADLINE:-}"
hard_deadline="${GREENLIGHT_REVIEW_HARD_DEADLINE:-}"

# An unset or malformed value means the workflow set up no budget for this run, or
# set one up wrong; stay silent rather than nudge against a garbage clock.
for value in "$now" "$start_epoch" "$target_deadline" "$soft_deadline" "$hard_deadline"; do
  [[ "$value" =~ ^[0-9]+$ ]] || exit 0
done

# Digits alone are not enough for $(( )), which reads a leading zero as octal: an
# epoch like 01788216101 is not a valid octal literal, so the expansion errors out and
# leaves its target variable unset for `set -u` to abort on. Pinning base 10 once here
# means no later arithmetic has to repeat it. `[ ]` and `[[ ]]` parse base 10 already
# and reject a 10# prefix as a syntax error, so they must never carry one.
now=$((10#$now))
start_epoch=$((10#$start_epoch))
target_deadline=$((10#$target_deadline))
soft_deadline=$((10#$soft_deadline))
hard_deadline=$((10#$hard_deadline))

reminder_interval="${GREENLIGHT_REVIEW_REMINDER_INTERVAL_SEC:-}"
urgent_interval="${GREENLIGHT_REVIEW_URGENT_INTERVAL_SEC:-}"
# Both reach an arithmetic context below, where bash evaluates the *contents* of a
# variable as an expression -- an unvalidated value is a command-substitution sink,
# not merely a wrong number. Unlike the deadlines these say nothing about whether a
# budget exists, so a rejected value falls back to its default instead of silencing
# the hook. The defaults live here and nowhere else.
[[ "$reminder_interval" =~ ^[0-9]+$ ]] || reminder_interval=180
[[ "$urgent_interval" =~ ^[0-9]+$ ]] || urgent_interval=60
reminder_interval=$((10#$reminder_interval))
urgent_interval=$((10#$urgent_interval))

# Default must stay equal to validate-on-stop.sh's VERDICT_FILE and to the path the
# workflow prompt names; the override exists so a test can observe both branches of
# the final tier without racing on a fixed global path.
verdict_file="${GREENLIGHT_REVIEW_VERDICT_FILE:-/tmp/greenlight-verdict.json}"

# The tier is decided BEFORE the rate-limit interval is chosen: reading the interval
# first would gate the urgent past-the-hard-limit nudge behind the relaxed interval
# that suits only the earlier tiers.
if ((now >= hard_deadline)); then
  tier=4
elif ((now >= soft_deadline)); then
  tier=3
elif ((now >= target_deadline)); then
  tier=2
else
  tier=1
  # The state file starts absent, so the first tool call of a run is never rate-limited
  # and tier 1 would otherwise fire on it every single time. A median review ends inside
  # the first half of the target window, where a reminder is pure noise. A non-positive
  # window has no meaningful halfway point, so the floor applies only to a sane one.
  target_window=$((target_deadline - start_epoch))
  if ((target_window > 0 && now - start_epoch < target_window / 2)); then
    exit 0
  fi
fi

if ((tier == 4)); then
  interval="$urgent_interval"
else
  interval="$reminder_interval"
fi

state="${RUNNER_TEMP:-/tmp}/greenlight-budget-reminder-last"
last=0
last_tier=0
if [[ -f "$state" ]]; then
  # The file is plain text in a shared temp dir, so a truncated write, a foreign writer, or
  # a file holding only one field must read as "no reminder yet". These guards keep such a
  # value out of the arithmetic below, where it would only error onto stderr; the 10# on
  # those assignments is what makes one that gets past them inert, since a subscript payload
  # naming a live variable does execute if it reaches $(( )) unprefixed.
  # Grouped so a redirection that fails outright (unreadable file) is silenced too: a
  # trailing 2>/dev/null is applied after the redirection it would have to cover.
  { read -r state_epoch state_tier _ <"$state"; } 2>/dev/null || true
  if [[ "${state_epoch:-}" =~ ^[0-9]+$ && "${state_tier:-}" =~ ^[0-9]+$ ]]; then
    last=$((10#$state_epoch))
    last_tier=$((10#$state_tier))
  fi
fi

# One state file serves every tier, so the interval must not carry across an
# escalation: inheriting the previous tier's cooldown costs up to a full reminder
# interval of silence exactly when the remaining window is at its shortest.
if ((tier <= last_tier && now - last < interval)); then
  exit 0
fi

target_budget_min=$(((target_deadline - start_epoch) / 60))

if ((tier == 4)); then
  if [[ -f "$verdict_file" ]]; then
    # The matcher is "*", so the Write that produces the verdict triggers this hook too.
    msg="Time check: the review time is spent and the verdict file is already written. No further investigation is expected."
  else
    # Points at the skill's criteria rather than restating them: an enumeration here is a
    # second definition of "critical" that can fall behind the skill's, and at the wall a
    # short list reads as an exhaustive one. The unexamined-criterion clause is not such a
    # restatement but the rule's quantifier: without it the rule ranges over the questions
    # the model happened to form, and a criterion it never looked at raises none, so a
    # review that skipped one reads this as LAND.
    msg="Time check: the review time is spent and the verdict is due now at $verdict_file. The rule at this point: a still-unanswered question that is critical under the skill's What to inspect criteria means NO_LAND, and a criterion there you never examined counts as one; only minor nits, esoteric questions, or non-critical edge cases left unanswered means LAND."
  fi
elif ((tier == 3)); then
  msg="Time check: about $(((hard_deadline - now) / 60)) minute(s) remain before the hard limit. Remaining time is for questions critical to the LAND/NO_LAND decision only."
elif ((tier == 2)); then
  msg="Time check: this review is past its ${target_budget_min}-minute standard target, with about $(((hard_deadline - now) / 60)) minute(s) before the hard limit. Unless this change is genuinely complex, the remaining work is writing the verdict."
else
  msg="Time check: about $(((target_deadline - now) / 60)) minute(s) remain of the ${target_budget_min}-minute standard review target. The diff is the primary source; checkout reads are lookups for specific questions rather than exploration."
fi

# Emit before recording. A jq that is present but exits non-zero would otherwise leave
# the clock advanced with nothing said, swallowing the next reminder too -- the very
# failure the probe above exists to prevent. Its stderr is discarded like every other
# fallible command here: Claude Code surfaces hook stderr to the operator as a
# non-blocking hook error, and this hook runs once per tool call.
payload=$(jq -nc --arg m "$msg" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$m}}' 2>/dev/null) || exit 0
printf '%s\n' "$payload"
{ printf '%s %s' "$now" "$tier" >"$state"; } 2>/dev/null || true
exit 0

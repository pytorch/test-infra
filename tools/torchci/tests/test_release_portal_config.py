import copy
from unittest import main, TestCase

from torchci import release_portal_config as cfg

from torchci.release_portal_config import ConfigError, resolve, validate_shared


def _step(sid="1.1", **overrides):
    step = {
        "id": sid,
        "phase": int(sid.split(".")[0]),
        "name": "A step",
        "tier": "M",
        "owner": "release-manager",
        "check": {"type": "manual_link", "what_to_check": "x", "link": "https://x"},
    }
    step.update(overrides)
    return step


DISCOVERY = {
    "milestone": {"repo": "pytorch/pytorch", "title": "{version}"},
    "tracker_issue": {
        "repo": "pytorch/pytorch",
        "query": "label:x",
        "title_regex": r"^\[v\.?{version}\] Release Tracker$",
    },
    "validation_issue": {
        "repo": "pytorch/pytorch",
        "query": "in:title validations",
        "title_regex": {
            "minor": "^Release ({minor}|{version}) validations",
            "patch": "^Release {version} validations",
        },
    },
}


RESOURCES = {
    "wheels": {
        "test": "https://download.pytorch.org/whl/test/",
        "release": "https://download.pytorch.org/whl/",
    },
    "docs": "https://docs.pytorch.org/docs/{minor}/",
}


def _shared(*steps):
    return {
        "version": 1,
        "discovery": copy.deepcopy(DISCOVERY),
        "resources": copy.deepcopy(RESOURCES),
        "phases": [{"id": 1, "name": "One"}, {"id": 2, "name": "Two"}],
        "steps": list(steps) or [_step("1.1"), _step("2.1")],
    }


def _release(**overrides):
    release = {
        "release": "2.16.0",
        "dates": {"branch_cut": None, "final_rc": None, "ga": None},
        "remove": [],
        "override": {},
        "add": [],
    }
    release.update(overrides)
    return release


class TestCommittedConfig(TestCase):
    def test_every_committed_file_is_valid(self):
        self.assertEqual(cfg.validate_all(), [])

    def test_the_shared_steps_cover_five_phases_and_resolve(self):
        resolved = cfg.load_resolved("2.16.0")
        self.assertEqual([p["id"] for p in resolved["phases"]], [1, 2, 3, 4, 5])
        self.assertEqual(len(resolved["steps"]), 46)
        self.assertEqual(resolved["branch"], "release/2.16")

    def test_every_step_id_is_unique_and_in_its_phase(self):
        steps = cfg.load_resolved("2.16.0")["steps"]
        self.assertEqual(len({s["id"] for s in steps}), len(steps))


class TestValidateShared(TestCase):
    def errors(self, shared):
        return validate_shared(shared)

    def test_a_minimal_config_is_valid(self):
        self.assertEqual(self.errors(_shared()), [])

    def test_unknown_tier(self):
        errors = self.errors(_shared(_step("1.1", tier="Z")))
        self.assertTrue(any("tier 'Z'" in e for e in errors), errors)

    def test_step_id_must_match_its_phase(self):
        errors = self.errors(_shared(_step("1.1", phase=2)))
        self.assertTrue(any("does not belong to phase 2" in e for e in errors), errors)

    def test_duplicate_id(self):
        errors = self.errors(_shared(_step("1.1"), _step("1.1")))
        self.assertTrue(any("duplicate id" in e for e in errors), errors)

    def test_undefined_phase(self):
        errors = self.errors(_shared(_step("3.1")))
        self.assertTrue(any("phase 3 is not defined" in e for e in errors), errors)

    def test_unknown_field_and_missing_field(self):
        step = _step("1.1", colour="red")
        del step["owner"]
        errors = self.errors(_shared(step))
        self.assertTrue(
            any("unknown field" in e and "colour" in e for e in errors), errors
        )
        self.assertTrue(any("missing ['owner']" in e for e in errors), errors)

    def test_unknown_dependency_and_cycle(self):
        errors = self.errors(_shared(_step("1.1", depends_on=["9.9"])))
        self.assertTrue(any("unknown step 9.9" in e for e in errors), errors)
        errors = self.errors(
            _shared(_step("1.1", depends_on=["1.2"]), _step("1.2", depends_on=["1.1"]))
        )
        self.assertTrue(any("dependency cycle" in e for e in errors), errors)
        errors = self.errors(_shared(_step("1.1", depends_on=["1.1"])))
        self.assertTrue(any("depends on itself" in e for e in errors), errors)

    def test_due_needs_a_known_anchor_and_an_integer_offset(self):
        for due in (
            {"anchor": "someday", "offset_days": 1},
            {"anchor": "ga", "offset_days": "1"},
            {"anchor": "ga"},
        ):
            with self.subTest(due=due):
                errors = self.errors(_shared(_step("1.1", due=due)))
                self.assertTrue(any("due must be" in e for e in errors), errors)
        self.assertEqual(
            self.errors(_shared(_step("1.1", due={"anchor": "ga", "offset_days": -2}))),
            [],
        )

    def test_runbook_has_exactly_one_known_key(self):
        for runbook in ({"script": "a", "skill": "b"}, {"wiki": "a"}, {}):
            with self.subTest(runbook=runbook):
                errors = self.errors(_shared(_step("1.1", runbook=runbook)))
                self.assertTrue(any("runbook" in e for e in errors), errors)
        self.assertEqual(
            self.errors(
                _shared(_step("1.1", runbook={"script": "release/promote.sh"}))
            ),
            [],
        )


class TestApplicability(TestCase):
    def errors(self, **fields):
        return validate_shared(_shared(_step("1.1", **fields)))

    def test_types(self):
        self.assertEqual(self.errors(types=["minor"]), [])
        self.assertEqual(self.errors(types=["minor", "patch"]), [])
        for types in ([], ["major"], ["minor", "minor"], "minor"):
            with self.subTest(types=types):
                self.assertTrue(
                    any("types must be" in e for e in self.errors(types=types))
                )

    def test_window(self):
        for window in (
            {"opens": "branch_cut", "closes": "ga"},
            {"opens": "branch_cut"},
            {"closes": "ga"},
        ):
            with self.subTest(window=window):
                self.assertEqual(self.errors(window=window), [])
        for window in (
            {},
            {"opens": "ga"},
            {"closes": "branch_cut"},
            {"after": "ga"},
            "ga",
        ):
            with self.subTest(window=window):
                self.assertTrue(
                    any("window must have" in e for e in self.errors(window=window))
                )

    def test_a_patch_release_leaves_out_minor_only_steps_and_their_dependencies(self):
        shared = _shared(
            _step("1.1", types=["minor"]),
            _step("1.2"),
            _step("2.1", depends_on=["1.1", "1.2"]),
        )
        patch = resolve(shared, _release(release="2.15.1"), "2.15.1.yml")
        self.assertEqual([s["id"] for s in patch["steps"]], ["1.2", "2.1"])
        self.assertEqual(patch["steps"][1]["depends_on"], ["1.2"])
        minor = resolve(shared, _release(), "2.16.0.yml")
        self.assertEqual([s["id"] for s in minor["steps"]], ["1.1", "1.2", "2.1"])
        self.assertEqual(minor["steps"][2]["depends_on"], ["1.1", "1.2"])

    def test_the_committed_patch_release_has_no_branch_cut(self):
        ids = {s["id"] for s in cfg.load_resolved("2.15.1")["steps"]}
        self.assertNotIn("1.8", ids)
        self.assertIn("1.2", ids)  # the milestone is checked for a patch release too
        self.assertIn("2.13", ids)  # and so are the reverts missing from the branch

    def test_the_milestone_is_checked_all_the_time_and_reverts_only_in_a_window(self):
        for version in ("2.15.1", "2.16.0"):
            steps = {s["id"]: s for s in cfg.load_resolved(version)["steps"]}
            self.assertEqual(
                steps["2.13"]["window"], {"opens": "branch_cut", "closes": "ga"}
            )
            for sid in ("1.2", "2.9", "3.1"):
                self.assertEqual(
                    steps[sid]["check"]["type"], "milestone_outstanding_items"
                )
                self.assertNotIn("window", steps[sid])


class TestChecks(TestCase):
    def errors(self, check):
        return validate_shared(_shared(_step("1.1", check=check)))

    def test_unknown_type(self):
        self.assertTrue(
            any("unknown check type" in e for e in self.errors({"type": "magic"}))
        )

    def test_missing_and_extra_parameters(self):
        errors = self.errors({"type": "url_exists", "link": "x"})
        self.assertTrue(any("missing ['url']" in e for e in errors), errors)
        self.assertTrue(any("does not take ['link']" in e for e in errors), errors)

    def test_unknown_template_variable(self):
        errors = self.errors({"type": "url_exists", "url": "https://x/{nope}"})
        self.assertTrue(any("unknown template variable" in e for e in errors), errors)
        self.assertEqual(
            self.errors({"type": "url_exists", "url": "https://x/{minor}/{rc}"}), []
        )

    def test_enumerated_parameters(self):
        bad = [
            {
                "type": "github_issue_state",
                "repo": "a/b",
                "issue": "1",
                "expect": "maybe",
            },
            {
                "type": "github_ref_exists",
                "repos": ["a/b"],
                "ref": "x",
                "kind": "commit",
            },
            {"type": "github_ref_exists", "repos": ["ab"], "ref": "x", "kind": "tag"},
            {"type": "github_ref_exists", "repos": [], "ref": "x", "kind": "tag"},
            {
                "type": "index_listing",
                "index": "s3",
                "channel": "test",
                "package_types": ["wheel"],
            },
            {
                "type": "index_listing",
                "index": "pypi",
                "channel": "nightly",
                "package_types": ["wheel"],
            },
            {
                "type": "index_listing",
                "index": "pypi",
                "channel": "test",
                "package_types": ["conda"],
            },
            {
                "type": "milestone_outstanding_items",
                "repo": "a/b",
                "milestone": "m",
                "max_outstanding": -1,
            },
            {
                "type": "milestone_outstanding_items",
                "repo": "a/b",
                "milestone": "m",
                "max_outstanding": True,
            },
        ]
        for check in bad:
            with self.subTest(check=check):
                self.assertNotEqual(self.errors(check), [])

    def test_check_types_without_parameters(self):
        self.assertEqual(self.errors({"type": "crcr_summary"}), [])

    def test_the_milestone_and_revert_checks(self):
        self.assertEqual(
            self.errors(
                {
                    "type": "milestone_outstanding_items",
                    "repo": "a/b",
                    "milestone": "{milestone}",
                    "max_outstanding": 0,
                }
            ),
            [],
        )
        self.assertEqual(
            self.errors(
                {
                    "type": "reverts_missing_from_branch",
                    "repo": "a/b",
                    "branch": "{branch}",
                }
            ),
            [],
        )
        # the old name is gone
        self.assertTrue(
            any(
                "unknown check type" in e
                for e in self.errors(
                    {
                        "type": "github_milestone_open_items",
                        "repo": "a/b",
                        "milestone": "m",
                        "max_open": 0,
                    }
                )
            )
        )


class TestResolve(TestCase):
    def test_no_changes_returns_the_shared_steps(self):
        resolved = resolve(_shared(), _release())
        self.assertEqual([s["id"] for s in resolved["steps"]], ["1.1", "2.1"])
        self.assertEqual(resolved["release"], "2.16.0")
        self.assertEqual(
            resolved["dates"], {"branch_cut": None, "final_rc": None, "ga": None}
        )

    def test_resolve_does_not_change_its_inputs(self):
        shared = _shared()
        before = copy.deepcopy(shared)
        resolve(
            shared,
            _release(
                remove=["1.1"], override={"2.1": {"owner": "x"}}, add=[_step("2.2")]
            ),
        )
        self.assertEqual(shared, before)

    def test_remove_override_and_add(self):
        resolved = resolve(
            _shared(),
            _release(
                remove=["1.1"],
                override={"2.1": {"owner": "docs-team", "rc_scoped": True}},
                add=[_step("2.2", name="Extra")],
            ),
        )
        steps = {s["id"]: s for s in resolved["steps"]}
        self.assertEqual(sorted(steps), ["2.1", "2.2"])
        self.assertEqual(steps["2.1"]["owner"], "docs-team")
        self.assertIs(steps["2.1"]["rc_scoped"], True)
        self.assertEqual(steps["2.2"]["name"], "Extra")

    def test_an_override_set_to_null_drops_the_field(self):
        shared = _shared(
            _step("1.1", due={"anchor": "ga", "offset_days": 1}), _step("2.1")
        )
        resolved = resolve(shared, _release(override={"1.1": {"due": None}}))
        self.assertNotIn("due", resolved["steps"][0])

    def test_type_and_branch_follow_from_the_version(self):
        for version, release_type, branch in (
            ("2.16.0", "minor", "release/2.16"),
            ("2.15.1", "patch", "release/2.15"),
        ):
            with self.subTest(version):
                resolved = resolve(
                    _shared(), _release(release=version), f"{version}.yml"
                )
                self.assertEqual(resolved["type"], release_type)
                self.assertEqual(resolved["branch"], branch)

    def test_links_are_empty_unless_set_and_the_rules_are_carried(self):
        resolved = resolve(_shared(), _release())
        self.assertEqual(
            resolved["links"],
            {"milestone": None, "tracker_issue": None, "validation_issue": None},
        )
        self.assertEqual(resolved["discovery"], DISCOVERY)
        resolved = resolve(_shared(), _release(links={"tracker_issue": 123}))
        self.assertEqual(resolved["links"]["tracker_issue"], 123)

    def test_dates_are_strings(self):
        import datetime

        resolved = resolve(
            _shared(),
            _release(dates={"ga": datetime.date(2027, 1, 20), "branch_cut": None}),
        )
        self.assertEqual(resolved["dates"]["ga"], "2027-01-20")

    def assert_rejected(self, release, text, shared=None):
        with self.assertRaises(ConfigError) as raised:
            resolve(shared or _shared(), release, "2.16.0.yml")
        self.assertTrue(
            any(text in e for e in raised.exception.errors), raised.exception.errors
        )

    def test_unknown_step_in_remove_and_override(self):
        self.assert_rejected(_release(remove=["9.9"]), "remove names unknown step 9.9")
        self.assert_rejected(
            _release(override={"9.9": {}}), "override names unknown step 9.9"
        )

    def test_override_cannot_change_id_or_phase(self):
        self.assert_rejected(
            _release(override={"1.1": {"phase": 2}}), "cannot change id or phase"
        )

    def test_an_added_step_must_be_complete_and_unique(self):
        incomplete = _step("2.2")
        del incomplete["tier"]
        self.assert_rejected(_release(add=[incomplete]), "missing ['tier']")
        self.assert_rejected(_release(add=[_step("2.1")]), "duplicate id")

    def test_an_override_that_breaks_a_step_is_rejected(self):
        self.assert_rejected(_release(override={"1.1": {"tier": "Z"}}), "tier 'Z'")

    def test_removing_a_step_another_step_needs_is_rejected(self):
        shared = _shared(_step("1.1"), _step("2.1", depends_on=["1.1"]))
        self.assert_rejected(
            _release(remove=["1.1"]), "depends on unknown step 1.1", shared
        )

    def test_release_file_checks(self):
        self.assert_rejected(_release(release="2.16"), "release must be")
        self.assert_rejected(_release(release="2.17.0"), "does not match the file name")
        self.assert_rejected(_release(type="patch"), "does not follow from the version")
        self.assert_rejected(_release(branch="release/2.15"), "should be release/2.16")
        self.assert_rejected(_release(links={"milestone": ["x"]}), "a link must be")
        self.assert_rejected(_release(dates={"ga": "next week"}), "YYYY-MM-DD")
        self.assert_rejected(_release(dates={"launch": None}), "dates may only have")
        self.assert_rejected(_release(links={"blog": "x"}), "links may only have")
        self.assert_rejected(_release(extra=1), "unknown field")


class TestResources(TestCase):
    def errors(self, mutate):
        shared = _shared()
        mutate(shared["resources"])
        return validate_shared(shared)

    def test_valid(self):
        self.assertEqual(self.errors(lambda r: None), [])

    def test_a_link_is_a_url_or_a_test_release_pair(self):
        self.assertEqual(
            self.errors(lambda r: r.update(notes="https://x/{version}/{branch}")), []
        )
        for bad in (
            "http://x",
            "",
            3,
            {"test": "https://x"},
            {"a": "https://x", "b": "https://y"},
        ):
            with self.subTest(bad=bad):
                self.assertTrue(self.errors(lambda r: r.update(notes=bad)))

    def test_unknown_variable_and_bad_name(self):
        errors = self.errors(lambda r: r.update(notes="https://x/{rc}"))
        self.assertTrue(any("unknown variable" in e for e in errors), errors)
        self.assertTrue(self.errors(lambda r: r.update({"Bad-Name": "https://x"})))

    def test_resources_are_required_and_carried_to_the_resolved_config(self):
        shared = _shared()
        del shared["resources"]
        self.assertTrue(any("resources must be" in e for e in validate_shared(shared)))
        self.assertEqual(resolve(_shared(), _release())["resources"], RESOURCES)

    def test_the_committed_resources(self):
        resources = cfg.load_resolved("2.16.0")["resources"]
        self.assertEqual(
            set(resources),
            {"wheels", "libtorch", "docs", "release_notes", "build_matrix"},
        )


class TestDiscoveryRules(TestCase):
    def errors(self, mutate):
        shared = _shared()
        mutate(shared["discovery"])
        return validate_shared(shared)

    def test_a_valid_rule_set(self):
        self.assertEqual(self.errors(lambda d: None), [])

    def test_each_kind_is_required_and_nothing_else_is_allowed(self):
        self.assertTrue(self.errors(lambda d: d.pop("milestone")))
        self.assertTrue(self.errors(lambda d: d.update(blog={})))

    def test_a_rule_needs_exactly_its_fields(self):
        self.assertTrue(self.errors(lambda d: d["milestone"].update(query="x")))
        self.assertTrue(self.errors(lambda d: d["tracker_issue"].pop("query")))
        self.assertTrue(
            self.errors(lambda d: d["tracker_issue"].update(repo="pytorch"))
        )

    def test_unknown_variable_and_bad_regex(self):
        errors = self.errors(lambda d: d["milestone"].update(title="{release}"))
        self.assertTrue(any("unknown variable" in e for e in errors), errors)
        errors = self.errors(lambda d: d["tracker_issue"].update(title_regex="^(open"))
        self.assertTrue(any("not a valid regex" in e for e in errors), errors)

    def test_a_regex_map_has_one_pattern_per_release_type(self):
        errors = self.errors(
            lambda d: d["validation_issue"].update(title_regex={"minor": "x"})
        )
        self.assertTrue(any("needs exactly" in e for e in errors), errors)


# Titles as they are in pytorch/pytorch.
MILESTONES = [
    {"number": 71, "title": "2.16.0", "html_url": "u/71"},
    {"number": 72, "title": "2.15.1", "html_url": "u/72"},
]
ISSUES = [
    {"number": 199813, "title": "[v.2.15.0] Release Tracker", "html_url": "u/199813"},
    {"number": 198239, "title": "[v2.14.1] Release Tracker", "html_url": "u/198239"},
    {
        "number": 201644,
        "title": "Release 2.15 validations checklist and cherry-picks",
        "html_url": "u/201644",
    },
    {
        "number": 167476,
        "title": "Release 2.9.1 validations checklist and cherry-picks",
        "html_url": "u/167476",
    },
    {
        "number": 164758,
        "title": "Release 2.9.0 validations and cherry picks",
        "html_url": "u/164758",
    },
    {
        "number": 5,
        "title": "[v.2.15.0] Release Tracker",
        "html_url": "u/5",
        "pull_request": {},
    },
]


class TestDiscovery(TestCase):
    def discover(self, version, **links):
        resolved = resolve(
            _shared(), _release(release=version, links=links), f"{version}.yml"
        )
        seen = []
        found = cfg.discover_links(
            resolved,
            milestones=lambda repo: MILESTONES,
            search=lambda repo, query: (seen.append(query), ISSUES)[1],
        )
        return found, seen

    def test_the_milestone_is_the_one_titled_with_the_version(self):
        found, _ = self.discover("2.16.0")
        self.assertEqual(
            found["milestone"], {"number": 71, "title": "2.16.0", "url": "u/71"}
        )
        found, _ = self.discover("2.15.1")
        self.assertEqual(found["milestone"]["number"], 72)
        found, _ = self.discover("2.99.0")
        self.assertIsNone(found["milestone"])

    def test_the_tracker_title_is_found_with_or_without_the_dot_after_v(self):
        rule = DISCOVERY["tracker_issue"]
        self.assertEqual(
            cfg.match_issue(ISSUES, rule, "2.15.0", "minor")["number"], 199813
        )
        self.assertEqual(
            cfg.match_issue(ISSUES, rule, "2.14.1", "patch")["number"], 198239
        )
        self.assertIsNone(cfg.match_issue(ISSUES, rule, "2.16.0", "minor"))

    def test_a_pull_request_is_never_a_match(self):
        rule = DISCOVERY["tracker_issue"]
        only_pr = [i for i in ISSUES if "pull_request" in i]
        self.assertIsNone(cfg.match_issue(only_pr, rule, "2.15.0", "minor"))

    def test_the_version_is_matched_literally_not_as_a_regex(self):
        rule = DISCOVERY["tracker_issue"]
        issues = [
            {"number": 1, "title": "[v.2x15y0] Release Tracker", "html_url": "u/1"}
        ]
        self.assertIsNone(cfg.match_issue(issues, rule, "2.15.0", "minor"))

    def test_the_validation_issue_of_a_minor_is_titled_with_the_minor_or_the_version(
        self,
    ):
        rule = DISCOVERY["validation_issue"]
        self.assertEqual(
            cfg.match_issue(ISSUES, rule, "2.15.0", "minor")["number"], 201644
        )
        self.assertEqual(
            cfg.match_issue(ISSUES, rule, "2.9.0", "minor")["number"], 164758
        )

    def test_a_patch_release_does_not_pick_up_its_minors_validation_issue(self):
        rule = DISCOVERY["validation_issue"]
        self.assertIsNone(cfg.match_issue(ISSUES, rule, "2.15.1", "patch"))
        self.assertEqual(
            cfg.match_issue(ISSUES, rule, "2.9.1", "patch")["number"], 167476
        )

    def test_the_newest_of_several_matches_wins(self):
        rule = DISCOVERY["tracker_issue"]
        issues = [
            {"number": 10, "title": "[v2.16.0] Release Tracker", "html_url": "u/10"},
            {"number": 30, "title": "[v.2.16.0] Release Tracker", "html_url": "u/30"},
            {"number": 20, "title": "[v2.16.0] Release Tracker", "html_url": "u/20"},
        ]
        self.assertEqual(cfg.match_issue(issues, rule, "2.16.0", "minor")["number"], 30)

    def test_a_link_set_in_the_release_file_is_not_searched_for(self):
        found, seen = self.discover(
            "2.15.0", milestone="m", tracker_issue=1, validation_issue=2
        )
        self.assertEqual(
            (found["milestone"], found["tracker_issue"], found["validation_issue"]),
            ("m", 1, 2),
        )
        self.assertEqual(seen, [])

    def test_the_searches_use_the_rules_queries(self):
        _, seen = self.discover("2.15.0")
        self.assertEqual(seen, ["label:x", "in:title validations"])


if __name__ == "__main__":
    main()

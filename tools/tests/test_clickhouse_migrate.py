import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from clickhouse_db_schema import migrate


class TestMigrationSandbox(unittest.TestCase):
    def validate_migration(self, sql: str) -> None:
        with TemporaryDirectory() as directory:
            folder = Path(directory)
            (folder / "000001-example.sql").write_text(sql, encoding="utf-8")
            migrate.migrations(folder)

    def test_rejects_qualified_delete_targets(self) -> None:
        for sql in (
            "DELETE FROM default.workflow_job WHERE 1;",
            "dElEtE\nFrOm\tdefault . workflow_job WHERE id = 123;",
            "DELETE FROM `default`.`workflow_job` WHERE 1;",
            'DELETE FROM "default"."workflow_job" WHERE 1;',
            "DELETE FROM`default`.`workflow_job` WHERE 1;",
            'DELETE FROM"default"."workflow_job" WHERE 1;',
            'DELETE FROM/* cleanup */"default"."workflow_job" WHERE 1;',
            "DELETE /* cleanup */ FROM default.workflow_job WHERE 1;",
            "DELETE -- cleanup\nFROM default.workflow_job WHERE 1;",
            "DELETE FROM default.workflow_job ON CLUSTER ci WHERE 1;",
        ):
            with self.subTest(sql=sql):
                with self.assertRaisesRegex(migrate.Failed, "names a database"):
                    self.validate_migration(sql)

    def test_allows_bare_delete_with_qualified_read(self) -> None:
        self.validate_migration(
            "DELETE FROM events WHERE id IN (SELECT id FROM default.workflow_job);"
        )

    def test_allows_qualified_reads(self) -> None:
        self.validate_migration(
            "CREATE MATERIALIZED VIEW events_mv TO events AS "
            "SELECT job.id FROM default.workflow_job AS job "
            "JOIN default.workflow_run AS run ON job.run_id = run.id;"
        )

    def test_ignores_delete_in_strings_and_comments(self) -> None:
        self.validate_migration(
            "SELECT 'DELETE FROM default.workflow_job WHERE 1' "
            "FROM default.workflow_job; "
            "/* DELETE FROM default.workflow_job WHERE 1; */"
            "-- DELETE FROM default.workflow_job WHERE 1;\n"
        )


if __name__ == "__main__":
    unittest.main()

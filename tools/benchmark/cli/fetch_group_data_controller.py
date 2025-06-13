from cement import Controller, ex
from cli.sub_clis.fetch_group_data_execubench_controller import run_execubench


class GroupDataQueryController(Controller):
    class Meta:
        label = "group-data-query"
        stacked_on = "base"
        stacked_type = "nested"
        help = "Group data query CLI"
        arguments = [
            (
                ["--name"],
                {
                    "help": "Which shorcut to run (e.g. execubench), default is `default`",
                    "dest": "name",
                    "default": "default",
                },
            ),
            (
                ["--env"],
                {
                    "help": "Environment (local or prod)",
                    "choices": ["local", "prod"],
                    "default": "prod",
                    "dest": "env",
                },
            ),
            (
                ["--startTime"],
                {
                    "help": "Start time: YYYY-MM-DDTHH:MM:SS",
                    "dest": "startTime",
                    "required": True,
                },
            ),
            (
                ["--endTime"],
                {
                    "help": "End time: YYYY-MM-DDTHH:MM:SS",
                    "dest": "endTime",
                },
            ),
        ]

    @ex(help="Run group data query")
    def run(self):
        args = self.app.pargs
        if not args.startTime or not args.endTime:
            print("[ERROR] --startTime and --endTime are required")
            return
        if args.name == "execubench":
            run_execubench(
                env=args.env,
                start_time=args.startTime,
                end_time=args.endTime,
            )
        else:
            print(f"[ERROR] Unsupported query name: {args.name}")

from cement import App, Controller
from cli.fetch_group_data_controller import GroupDataQueryController


class BaseController(Controller):
    class Meta:
        label = "base"
        help = "pt2-bm-cli: PyTorch Benchmark CLI"


class Pt2BMCLI(App):
    class Meta:
        label = "pt2-bm-cli"
        base_controller = "base"
        handlers = [
            BaseController,
            GroupDataQueryController,
        ]


def main():
    with Pt2BMCLI() as app:
        app.run()


if __name__ == "__main__":
    main()

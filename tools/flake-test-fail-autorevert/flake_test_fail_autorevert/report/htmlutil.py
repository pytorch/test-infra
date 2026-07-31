import html


def escape(value: str) -> str:
    return html.escape(str(value))


def tip_attr(tooltip: str, base_class: str = "") -> str:
    """Build the class/data-tip attributes for a hover explanation. The visible cue
    and the popup are pure CSS (see .tip in the report stylesheet): a dotted underline
    + help cursor signal the hover, and :hover::after shows the text instantly. Native
    title= is deliberately not used — it has no visual cue and a ~1s delay."""
    if not tooltip:
        return f' class="{base_class}"' if base_class else ""
    cls = (base_class + " tip").strip()
    return f' class="{cls}" data-tip="{escape(tooltip)}"'


def stat_card(n: int, label: str, title: str = "") -> str:
    return (
        f'<div{tip_attr(title, "stat")}><div class="n">{n}</div>'
        f'<div class="l">{escape(label)}</div></div>'
    )

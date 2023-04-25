import boscoci

boscoci.main(
    commands=[['black', '--check', '--diff', '.']], extra_packages=['black==23.3.0']
)

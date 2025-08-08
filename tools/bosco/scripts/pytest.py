import boscoci

boscoci.main(commands=[['pytest']], extra_packages=['.', 'pytest==7.3.1'])
